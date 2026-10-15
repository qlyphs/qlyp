"""Separate raw-RPC ingestion / SCALE event and extrinsic decoding for the Python witness.

The portable metadata description is decoded by polkadot.js on this witness's own
connection, but event decoding, event-to-extrinsic binding, transaction parsing and
asset accounting are implemented here, independently of QuantusNode.block().
A trusted full node still establishes consensus and verifies transaction signatures.
"""
import hashlib
import json
import time
import urllib.request
from replay import Reader, need, hx, unhex, ZERO, MAINNET

# Mainnet counts a block as final this many blocks below the best one, or at the node's finalized
# block when that is newer. It must equal MAINNET_FINALITY_DEPTH in packages/native/src/network.ts:
# both witnesses have to agree on which blocks are final. Development keeps the node's finality.
MAINNET_FINALITY_DEPTH = 20


def finality_depth(genesis):
    return MAINNET_FINALITY_DEPTH if genesis == MAINNET else None


def final_height(best, node_finalized, depth):
    need(type(best) is int and type(node_finalized) is int and 0 <= node_finalized <= best, 'invalid chain heads')
    return node_finalized if depth is None else max(node_finalized, best - depth)


class Node:
    def __init__(self, url, schema, genesis, runtime_hash, runtime):
        need(url.startswith(('http://', 'https://')), 'Python witness requires HTTP RPC')
        need(type(runtime) is dict and set(runtime) == {'specVersion', 'transactionVersion'}
             and all(type(v) is int and v > 0 for v in runtime.values()), 'runtime pin')
        self.url, self.schema, self.genesis, self.runtime_hash = url, schema, genesis, runtime_hash
        self.depth = finality_depth(genesis)
        self.spec, self.tx_version = runtime['specVersion'], runtime['transactionVersion']
        self.types = {int(t['id']): t['type'] for t in schema['types']}
        self.key = schema['eventsKey']
        need(self.key == '0x26aa394eea5630e07c48ae0c9558cef780d41e5e16056765bc8461851072c9d7', 'System.Events key')
        self.deadline = self.budget = None
        need(self.rpc('chain_getBlockHash', [0]) == genesis, 'genesis mismatch')
        # Mainnet only reaches this point once the ledger accepted its reviewed activation.
        need(genesis == MAINNET or 'dev' in self.rpc('system_chain', []).lower(), 'development chain required')

    def limit(self, deadline, budget):
        # A tip's epoch-millisecond deadline and byte budget; None lifts them.
        self.deadline, self.budget = deadline, budget

    def rpc(self, method, params):
        timeout = 10
        if self.deadline is not None:
            left = self.deadline / 1000 - time.time()
            need(left > 0, 'tip deadline')
            timeout = min(timeout, left)
        request = urllib.request.Request(self.url, data=json.dumps(dict(jsonrpc='2.0', id=1, method=method, params=params)).encode(), headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(request, timeout=timeout) as response:
            raw = response.read(16*1024*1024+1)
        need(len(raw) <= 16*1024*1024, 'RPC size limit')
        if self.budget is not None:
            self.budget -= len(raw)
            need(self.budget >= 0, 'tip data budget')
        result = json.loads(raw)
        need('error' not in result and 'result' in result, 'RPC error')
        return result['result']

    def decode(self, r, type_id, depth=0):
        need(depth <= 48, 'SCALE nesting')
        definition = self.types[int(type_id)]['def']
        def child(t):
            return self.decode(r, t, depth+1)
        if 'primitive' in definition:
            p = definition['primitive'].lower()
            if p == 'bool':
                v = r.num(1); need(v <= 1); return bool(v)
            if p == 'str':
                return r.vector(16384).decode('utf8')
            if p[0] in ('u', 'i') and p[1:].isdigit():
                bits = int(p[1:]); need(bits in (8,16,32,64,128,256))
                return int.from_bytes(r.read(bits//8),'little',signed=p[0]=='i')
            raise ValueError('unknown primitive')
        if 'compact' in definition:
            return r.comp()
        if 'array' in definition:
            a = definition['array']; need(0 <= int(a['len']) <= 100000)
            return [child(a['type']) for _ in range(int(a['len']))]
        if 'sequence' in definition:
            count = r.comp(); need(count <= 100000)
            return [child(definition['sequence']['type']) for _ in range(count)]
        if 'tuple' in definition:
            return [child(t) for t in definition['tuple']]
        if 'composite' in definition:
            return self.fields(r, definition['composite']['fields'], depth)
        if 'variant' in definition:
            tag = r.num(1)
            variants = [v for v in definition['variant']['variants'] if int(v['index']) == tag]
            need(len(variants) == 1, 'unknown variant')
            v = variants[0]
            return {'tag': v['name'], 'fields': self.fields(r, v['fields'], depth)}
        raise ValueError('unsupported SCALE type')

    def fields(self, r, fields, depth):
        values = [self.decode(r, f['type'], depth+1) for f in fields]
        if fields and all(f.get('name') is not None for f in fields):
            return {f['name']: v for f,v in zip(fields,values)}
        return values

    @staticmethod
    def account(value):
        while isinstance(value,list) and len(value)==1:
            value=value[0]
        need(isinstance(value,list) and len(value)==32 and all(type(x) is int and 0<=x<=255 for x in value), 'AccountId32')
        return hx(bytes(value))

    def normalize(self, event):
        pallet = event['tag']
        value = event['fields'][0]
        method, f = value['tag'], value['fields']
        name = pallet[:1].lower()+pallet[1:]+'.'+method
        def account(key):
            return self.account(f[key])
        if pallet == 'Multisig':
            if method == 'MultisigCreated':
                event = dict(kind='multisig',id=account('multisig_address'),threshold=f['threshold'],signers=[self.account(a) for a in f['signers']])
                # Creator and nonce identify a progressive mint ticket; legacy rules never read them.
                if 'creator' in f:
                    event['creator'] = account('creator')
                if 'nonce' in f:
                    need(type(f['nonce']) is int and 0 <= f['nonce'] < 2**64, 'multisig nonce')
                    event['nonce'] = f['nonce']
                return name,event
            if method == 'ProposalCreated':
                return name,dict(kind='created',multisig=account('multisig_address'),proposal=f['proposal_id'],proposer=account('proposer'))
            if method == 'SignerApproved':
                return name,dict(kind='approved',multisig=account('multisig_address'),proposal=f['proposal_id'],approver=account('approver'))
            if method in ('ProposalCancelled','ProposalRemoved','ProposalExecuted'):
                return name,dict(kind='closed',multisig=account('multisig_address'),proposal=f['proposal_id'])
        if pallet == 'Balances' and method == 'Transfer':
            return name,dict(kind='paid',**{'from':account('from'),'to':account('to'),'amount':f['amount']})
        if pallet == 'System' and method == 'Remarked':
            return name,dict(kind='remarked',sender=account('sender'))
        if pallet == 'Utility' and method == 'BatchCompleted':
            return name,dict(kind='batchCompleted')
        return name,None

    @staticmethod
    def transaction(raw):
        binary = unhex(raw)
        outer = Reader(binary);size=outer.comp();body=outer.read(size);outer.end()
        r=Reader(body);version=r.num(1)
        tx_hash=hx(hashlib.blake2b(binary,digest_size=32).digest())
        if version in (4,5):
            need(len(body)-r.at>=2, 'short inherent')
            return tx_hash,None,'0x'
        need(version==0x84 and r.num(1)==0, 'unsupported extrinsic')
        owner=r.ident();scheme=r.num(1);need(scheme in (0,1), 'signature scheme')
        r.read(7219 if scheme==0 else 5261)
        if r.num(1)!=0:
            r.num(1)
        r.comp();r.comp();need(r.num(1)==0, 'metadata hash extension')
        return tx_hash,owner,hx(r.read(len(body)-r.at))

    def block(self, height, block_hash, final=True):
        need(self.rpc('chain_getBlockHash',[height]) == block_hash, 'noncanonical block')
        result=self.rpc('chain_getBlock',[block_hash]);need(result and 'block' in result)
        block=result['block'];header=block['header'];need(int(header['number'],16)==height)
        parent=header['parentHash']
        version=self.rpc('state_getRuntimeVersion',[parent])
        need(version['specName']=='quantus-runtime' and version['specVersion']==self.spec and version['transactionVersion']==self.tx_version,'runtime')
        need(self.rpc('state_getStorageHash',['0x3a636f6465',parent])==self.runtime_hash,'runtime fingerprint')
        # A tip (final=False) is computed on a copy of the ledger, never kept as finalized state.
        if final:
            # The TS witness picked this block a moment earlier: a tip that fell back by a block or
            # two since then gets a few seconds to grow back before the block is refused.
            for attempt in range(6):
                finalized=self.rpc('chain_getHeader',[self.rpc('chain_getFinalizedHead',[])])
                # Read after the finalized head, so the best block cannot be the older of the two.
                best=self.rpc('chain_getHeader',[])
                if final_height(int(best['number'],16),int(finalized['number'],16),self.depth)>=height: break
                if attempt<5: time.sleep(2)
            else:
                need(False,'unfinalized block')
        encoded=self.rpc('state_getStorage',[self.key,block_hash]);need(encoded is not None,'events absent')
        r=Reader(unhex(encoded));records=self.decode(r,self.schema['eventsType']);r.end()
        groups={}
        for record in records:
            name,event=self.normalize(record['event'])
            phase=record['phase']
            if phase['tag']!='ApplyExtrinsic':
                need(not event or event['kind'] not in ('multisig','created','approved','closed'),'unexpected lifecycle hook')
                continue
            i=phase['fields'][0];need(type(i) is int and 0<=i<len(block['extrinsics']),'event phase')
            groups.setdefault(i,[]).append((name,event))
        receipts=[]
        for index,raw in enumerate(block['extrinsics']):
            tx_hash,owner,call_hex=self.transaction(raw)
            events=groups.get(index,[])
            outcomes=[name for name,ev in events if name in ('system.ExtrinsicSuccess','system.ExtrinsicFailed')]
            need(len(outcomes)==1,'execution outcome')
            receipts.append(dict(index=index,hash=tx_hash,signer=owner,callHex=call_hex,success=outcomes[0]=='system.ExtrinsicSuccess',events=[ev for name,ev in events if ev]))
        # spec/txVersion name the block format the rules read, as the TypeScript reader does; the
        # runtime itself was checked against the pin above.
        return dict(height=height,hash=block_hash,parent=parent,spec=152,txVersion=6,finalized=height,receipts=receipts)
