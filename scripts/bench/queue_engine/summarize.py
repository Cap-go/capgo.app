#!/usr/bin/env python3
"""Summarize bench.sh result folders into a markdown table + JSON."""
import glob, json, os, re, statistics, sys

root = sys.argv[1] if len(sys.argv) > 1 else os.path.join(os.path.dirname(os.path.abspath(__file__)), 'runs')

def lsn(s):
    hi, lo = s.split('/')
    return (int(hi, 16) << 32) + int(lo, 16)

def snap(path):
    f = open(path).read().strip().split('|')
    return {'lsn': lsn(f[0]), 'ins': int(f[1]), 'upd': int(f[2]), 'del': int(f[3]), 'dead': int(f[4]),
            'vacuums': int(f[5]), 'bytes': int(f[6]), 'blks': int(f[7]), 'xacts': int(f[8])}

def pct(xs, p):
    if not xs: return None
    xs = sorted(xs); return xs[min(len(xs) - 1, int(p * len(xs)))]

runs = []
for d in sorted(glob.glob(os.path.join(root, '*_x*'))):
    if not os.path.exists(os.path.join(d, 'snap1')): continue
    name = os.path.basename(d)
    sysname, rest = name.split('_x', 1)
    load = int(rest.split('_')[0]); longtx = 'longtx' in rest
    tick = int(rest.split('_tick')[1]) if '_tick' in rest else 100
    s0, s1 = snap(os.path.join(d, 'snap0')), snap(os.path.join(d, 'snap1'))
    cpu0, cpu1, rate = open(os.path.join(d, 'cpu')).read().split()
    cpu_s = (int(cpu1) - int(cpu0)) / 1e6
    sends = 0; stmt = {}
    for line in open(os.path.join(d, 'pgss')):
        q, calls, total, mean, mx, rows = line.rstrip('\n').rsplit('|', 5)
        calls = int(calls); total = float(total); mean = float(mean); mx = float(mx)
        ql = q.lower()
        key = None
        if re.search(r'select (pgmq|pgque)\.send\(', ql): key = 'send'; sends += calls
        elif 'pgmq.read(' in ql: key = 'read'
        elif 'pgmq.delete(' in ql: key = 'delete'
        elif 'update pgmq.q_' in ql: key = 'cf_ids_edit'
        elif 'pgque.next_batch(' in ql: key = 'next_batch'
        elif 'pgque.get_batch_events(' in ql: key = 'get_batch_events'
        elif 'pgque.ack(' in ql: key = 'ack'
        elif 'pgque.nack(' in ql: key = 'nack'
        elif 'call bench.consume' in ql: key = 'consumer_poll'
        if key and key not in stmt:
            stmt[key] = {'calls': calls, 'mean_ms': round(mean, 3), 'max_ms': round(mx, 1), 'total_s': round(total / 1000, 2)}
    lat = []
    for f in glob.glob(os.path.join(d, 'pgb.*')):
        for line in open(f):
            p = line.split()
            if len(p) >= 3: lat.append(int(p[2]) / 1000)
    backlog = [l.split() for l in open(os.path.join(d, 'backlog'))] if os.path.exists(os.path.join(d, 'backlog')) else []
    bl = [int(b[1] or 0) for b in backlog if len(b) > 1]
    dead = [int(b[2] or 0) for b in backlog if len(b) > 2]
    polls = [float(b) - float(a) for a, b in (l.split() for l in open(os.path.join(d, 'consumer_polls')))] if os.path.exists(os.path.join(d, 'consumer_polls')) else []
    tw = (s1['ins'] - s0['ins']) + (s1['upd'] - s0['upd']) + (s1['del'] - s0['del'])
    wal = s1['lsn'] - s0['lsn']
    runs.append({
        'run': name, 'engine': sysname, 'load': load, 'longtx': longtx, 'tick_ms': tick, 'messages': sends,
        'cpu_s': round(cpu_s, 1), 'cpu_ms_per_1k_msgs': round(cpu_s * 1e6 / max(sends, 1), 1),
        'wal_mb': round(wal / 1048576, 1), 'wal_bytes_per_msg': round(wal / max(sends, 1)),
        'tuple_writes_per_msg': round(tw / max(sends, 1), 2), 'dead_tuples_max': max(dead or [s1['dead']]),
        'vacuums': s1['vacuums'] - s0['vacuums'], 'engine_bytes_end': s1['bytes'],
        'produce_latency_ms_p50': round(pct(lat, .5) or 0, 2), 'produce_latency_ms_p99': round(pct(lat, .99) or 0, 2),
        'consumer_poll_s_avg': round(statistics.mean(polls), 3) if polls else None,
        'consumer_poll_s_max': round(max(polls), 3) if polls else None,
        'backlog_max': max(bl) if bl else None, 'statements': stmt,
    })

json.dump(runs, open(os.path.join(root, 'summary.json'), 'w'), indent=2)
cols = [('run', 'run'), ('messages', 'msgs'), ('cpu_ms_per_1k_msgs', 'DB CPU ms / 1k msgs'), ('wal_bytes_per_msg', 'WAL B / msg'),
        ('tuple_writes_per_msg', 'tuple writes / msg'), ('dead_tuples_max', 'max dead tuples'), ('vacuums', 'vacuums'),
        ('engine_bytes_end', 'engine size end (B)'), ('produce_latency_ms_p50', 'send p50 ms'), ('produce_latency_ms_p99', 'send p99 ms'),
        ('consumer_poll_s_avg', 'poll avg s'), ('consumer_poll_s_max', 'poll max s'), ('backlog_max', 'max backlog')]
print('| ' + ' | '.join(c[1] for c in cols) + ' |')
print('|' + '---|' * len(cols))
for r in sorted(runs, key=lambda r: (r['longtx'], r['load'], r['engine'], r['tick_ms'])):
    print('| ' + ' | '.join(str(r[c[0]]) for c in cols) + ' |')
