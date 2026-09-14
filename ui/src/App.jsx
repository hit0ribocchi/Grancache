import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Divider, Flex, Modal, Progress, Row,
  Segmented, Space, Switch, Table, Tag, Tooltip, Typography, message,
} from 'antd';
import {
  CloudServerOutlined, DatabaseOutlined, FileTextOutlined, GlobalOutlined,
  InfoCircleOutlined, PlayCircleOutlined, ReloadOutlined, RocketOutlined,
  StopOutlined, ThunderboltOutlined,
} from '@ant-design/icons';

const { Title, Text, Paragraph } = Typography;
const token = document.querySelector('meta[name="gbf-panel-token"]')?.content || '';

async function api(path, options = {}) {
  const res = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', 'x-gbf-panel': token, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({ ok: false, message: '返回不是 JSON' }));
  if (!res.ok || data.ok === false) throw new Error(data.message || `HTTP ${res.status}`);
  return data;
}

const fmtDuration = (s) => {
  if (s == null) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return [h, m, sec].map((v) => String(v).padStart(2, '0')).join(':');
};

const fmtBytes = (n) => {
  if (!n) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = Number(n);
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 || v >= 100 ? Math.round(v) : v.toFixed(1)} ${units[i]}`;
};

const CARD = { background: '#161b22', borderColor: '#30363d' };

const LEVEL_COLOR = { DEBUG: 'default', INFO: 'blue', WARN: 'orange', ERROR: 'red' };

function kindColor(kind) {
  if (/^(HIT|OPTIONS-HIT|OVERRIDE)/.test(kind)) return 'green';
  if (/^REVALIDATED/.test(kind)) return 'cyan';
  if (/^STALE/.test(kind)) return 'gold';
  if (/^MISS->STORE/.test(kind)) return 'blue';
  if (/^MISS-NOSTORE/.test(kind)) return 'orange';
  if (/^MISS/.test(kind)) return 'geekblue';
  if (/^BYPASS/.test(kind)) return 'default';
  if (/ERROR|FAIL/.test(kind)) return 'red';
  return 'default';
}

// 日志行 -> 表格行。请求行的形态不统一：
//   INFO HIT 12.0KB host /path | cache=1 total=2
//   DEBUG BYPASS 200 120B (set-cookie) host /path | up=124 … total=124
//   WARN RETRY-STALE (第 1 次失败：…) host /path | total=1
//   INFO MISS->STORE 12.0KB (asset-host, ttl=0s) host /path | …
// 所以先去掉括号里的原因，再按「状态码 / 大小 / 主机 / 路径」逐个挑，
// 挑不出主机就整段塞进「路径」列（例如 [stats] 那种非请求行），绝不丢内容。
const LINE_RE = /^(\S+)T(\d{2}:\d{2}:\d{2})\.\d+Z\s+(DEBUG|INFO|WARN|ERROR)\s+(.*)$/;
const SIZE_RE = /^\d[\d.]*(?:B|KB|MB|GB)$/;
const HOST_RE = /^(localhost|[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)$/;

function splitHead(head) {
  const toks = String(head || '').replace(/\(.*\)/g, ' ').split(/\s+/).filter(Boolean);
  const kind = toks.shift() || '';
  let size = '';
  let status = '';
  const rest = [];
  for (const t of toks) {
    if (!size && SIZE_RE.test(t)) {
      size = t;
      continue;
    }
    if (!status && /^\d{3}$/.test(t)) {
      status = t;
      continue;
    }
    rest.push(t);
  }
  let host = '';
  let path = '';
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    const slash = t.indexOf('/');
    const maybeHost = slash > 0 ? t.slice(0, slash) : slash === -1 ? t : '';
    if (maybeHost && HOST_RE.test(maybeHost)) {
      host = maybeHost;
      path = slash >= 0 ? t.slice(slash) : rest[i + 1] || '';
      break;
    }
  }
  if (!host) path = rest.join(' ');
  return { kind, size, status, host, path };
}

function parseLog(text) {
  return String(text || '')
    .split('\n')
    .filter((l) => l.trim())
    .map((raw, i) => {
      const m = LINE_RE.exec(raw);
      if (!m) {
        return { key: `raw${i}`, time: '', level: '', kind: '', size: '', status: '', ms: '', host: '', path: raw };
      }
      const [, , time, level, rest] = m;
      const [head, tail = ''] = rest.split(/\s+\|\s+/, 2);
      const ms = (/(?:^|\s)total=(\d+)/.exec(tail) || [])[1] || '';
      return { key: `r${i}`, time, level, ms, ...splitHead(head) };
    });
}

const FILTERS = {
  全部: () => true,
  命中: (r) => /^(HIT|OPTIONS-HIT|OVERRIDE|STALE|REVALIDATED)/.test(r.kind),
  回源: (r) => /^MISS/.test(r.kind),
  透传: (r) => /^BYPASS/.test(r.kind),
  异常: (r) => r.level === 'WARN' || r.level === 'ERROR',
};

const COLUMNS = [
  { title: '时间', dataIndex: 'time', width: 78, render: (v) => <span style={{ color: '#8b949e' }}>{v}</span> },
  {
    title: '级别',
    dataIndex: 'level',
    width: 66,
    render: (v) => (v ? <Tag color={LEVEL_COLOR[v] || 'default'} style={{ marginRight: 0 }}>{v}</Tag> : null),
  },
  {
    title: '结果',
    dataIndex: 'kind',
    width: 132,
    render: (v) => (v ? <Tag color={kindColor(v)} style={{ marginRight: 0 }}>{v}</Tag> : null),
  },
  { title: '大小', dataIndex: 'size', width: 74, align: 'right' },
  { title: '状态', dataIndex: 'status', width: 60, align: 'right' },
  { title: '耗时', dataIndex: 'ms', width: 76, align: 'right', render: (v) => (v ? `${v} ms` : '') },
  { title: '主机', dataIndex: 'host', width: 200, ellipsis: true },
  { title: '路径', dataIndex: 'path', ellipsis: true },
];

export default function App() {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(null);
  const [logText, setLogText] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [busy, setBusy] = useState(null);
  const [logFilter, setLogFilter] = useState('全部');
  const [modal, modalHolder] = Modal.useModal();
  const [msg, msgHolder] = message.useMessage();

  const refresh = useCallback(async () => {
    try {
      setStatus(await api('/api/status'));
      setErr(null);
    } catch (e) {
      setErr(e.message);
    }
  }, []);

  const refreshLog = useCallback(async () => {
    try {
      const r = await api('/api/log?lines=400');
      setLogText(r.text || '');
    } catch {
      /* 日志读不到不影响主功能 */
    }
  }, []);

  useEffect(() => {
    refresh();
    refreshLog();
  }, [refresh, refreshLog]);

  useEffect(() => {
    if (!autoRefresh) return undefined;
    const t = setInterval(() => {
      refresh();
      refreshLog();
    }, 2000);
    return () => clearInterval(t);
  }, [autoRefresh, refresh, refreshLog]);

  const run = async (action, label) => {
    setBusy(action);
    try {
      const r = await api('/api/action', { method: 'POST', body: JSON.stringify({ action }) });
      msg.success(r.message || `${label} 完成`);
      await refresh();
      await refreshLog();
    } catch (e) {
      msg.error(`${label} 失败：${e.message}`);
    } finally {
      setBusy(null);
    }
  };

  const onClear = () =>
    modal.confirm({
      title: '清空素材缓存？',
      content: '会删掉缓存对象（_ap 魔改文件保留）。下次进游戏需要重新下载素材。',
      okText: '确认清空',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => run('clear-cache', '清空缓存'),
    });

  const running = !!status?.proxy?.running;
  const st = status?.proxy?.stats || null;
  const busyWith = (action) => busy === action;

  const hits = st?.hits ?? 0;
  const misses = st?.misses ?? 0;
  const cacheable = hits + misses;
  const hitRate = st?.hitRate ?? 0;
  const usedMb = st?.cache?.megabytes ?? 0;
  const maxMb = st?.cache?.maxBytes ? st.cache.maxBytes / 1048576 : 0;
  const cachePct = maxMb ? Math.min(100, Number(((usedMb / maxMb) * 100).toFixed(1))) : 0;
  const latency = st?.latency || {};

  const rows = useMemo(() => parseLog(logText), [logText]);
  const visibleRows = useMemo(
    () => rows.filter(FILTERS[logFilter] || FILTERS.全部).reverse(),
    [rows, logFilter]
  );

  const kpi = (title, value, suffix, sub, bar) => (
    <Card style={CARD} styles={{ body: { padding: 18 } }}>
      <Text type="secondary" style={{ fontSize: 12 }}>{title}</Text>
      <div style={{ fontSize: 24, lineHeight: 1.35, fontWeight: 500 }}>
        {value}
        {suffix ? <span style={{ fontSize: 12, color: '#8b949e', marginLeft: 4 }}>{suffix}</span> : null}
      </div>
      {bar}
      <Text type="secondary" style={{ fontSize: 12 }}>{sub}</Text>
    </Card>
  );

  return (
    <div style={{ minHeight: '100vh', background: '#0f1115', padding: 20 }}>
      {msgHolder}
      {modalHolder}

      <Card style={{ ...CARD, marginBottom: 16 }} styles={{ body: { padding: 16 } }}>
        <Flex align="center" justify="space-between" wrap="wrap" gap={12}>
          <Space size={12} align="center">
            <ThunderboltOutlined style={{ fontSize: 26, color: '#7ee787' }} />
            <div>
              <Title level={4} style={{ margin: 0 }}>Grancache · 碧蓝幻想缓存代理</Title>
              <Text type="secondary" style={{ fontSize: 12 }}>
                一键启动 = 起缓存 + 用带缓存的配置打开 Chrome 进游戏；也可以只开关缓存
              </Text>
            </div>
          </Space>
          <Space size={8} wrap>
            <Tag color={running ? 'success' : 'default'} style={{ fontSize: 13, padding: '3px 10px', marginRight: 0 }}>
              {running ? `● 运行中 · PID ${st?.pid ?? status?.pid ?? '?'}` : '● 已停止'}
            </Tag>
            <Tooltip title={`运行时长 ${fmtDuration(st?.uptimeSeconds)}`}>
              <Tag style={{ marginRight: 0 }}>{fmtDuration(st?.uptimeSeconds)}</Tag>
            </Tooltip>
            <Tooltip title="上游出口：出站请求交给本机哪个代理">
              <Tag style={{ marginRight: 0 }} color={st?.upstream ? 'blue' : 'default'}>
                出口 {st?.upstream || '—'}
              </Tag>
            </Tooltip>
            <Tooltip title="立即刷新">
              <Button icon={<ReloadOutlined />} onClick={() => { refresh(); refreshLog(); }} />
            </Tooltip>
          </Space>
        </Flex>
      </Card>

      {err && (
        <Alert type="error" showIcon style={{ marginBottom: 16 }} message="面板连不上本地控制服务" description={err} />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} lg={6}>
          <Card style={CARD} styles={{ body: { padding: 18 } }}>
            <Flex align="center" gap={16}>
              <Progress
                type="circle"
                percent={hitRate}
                size={84}
                strokeWidth={8}
                strokeColor="#7ee787"
                trailColor="#21262d"
                format={(p) => <span style={{ fontSize: 15, color: '#c9d1d9' }}>{p}%</span>}
              />
              <div>
                <Text type="secondary" style={{ fontSize: 12 }}>可缓存命中率</Text>
                <div style={{ fontSize: 22, lineHeight: 1.4 }}>{hits}</div>
                <Text type="secondary" style={{ fontSize: 12 }}>命中 · 回源 {misses}</Text>
              </div>
            </Flex>
          </Card>
        </Col>
        <Col xs={24} sm={12} lg={6}>
          {kpi(
            '缓存占用',
            usedMb.toFixed(1),
            'MB',
            `${st?.cache?.objects ?? 0} 个对象 · 上限 ${maxMb ? (maxMb / 1024).toFixed(0) : '—'} GB`,
            <Progress percent={cachePct} showInfo={false} strokeWidth={6} strokeColor="#58a6ff" trailColor="#21262d" style={{ margin: '2px 0 6px' }} />
          )}
        </Col>
        <Col xs={24} sm={12} lg={6}>
          {kpi('请求', st?.requests ?? 0, '', `可缓存 ${cacheable} · 透传 ${st?.bypass ?? 0}（不缓存）`)}
        </Col>
        <Col xs={24} sm={12} lg={6}>
          {kpi(
            '时延 p50',
            latency.total?.p50 ?? '—',
            'ms',
            `p90 ${latency.total?.p90 ?? '—'} ms · 上游 ${latency.up?.p50 ?? '—'} ms`
          )}
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} lg={10}>
          <Card title="操作" style={CARD}>
            <Space direction="vertical" size={12} style={{ width: '100%' }}>
              <Button
                type="primary"
                size="large"
                block
                icon={<RocketOutlined />}
                loading={busyWith('start-all')}
                onClick={() => run('start-all', '一键启动')}
              >
                一键启动（缓存 + Chrome + 游戏）
              </Button>
              <Text type="secondary" style={{ fontSize: 12 }}>
                会先确保缓存在后台运行，再用带缓存配置的 Chrome 打开游戏（Chrome 已在运行时请先完全退出）
              </Text>

              <Divider style={{ margin: '2px 0' }}>只控制缓存</Divider>

              <Flex gap={10} wrap="wrap">
                <Button
                  icon={<PlayCircleOutlined />}
                  disabled={running}
                  loading={busyWith('start-proxy')}
                  onClick={() => run('start-proxy', '启动缓存')}
                >
                  启动缓存
                </Button>
                <Button
                  icon={<StopOutlined />}
                  disabled={!running}
                  loading={busyWith('stop-proxy')}
                  onClick={() => run('stop-proxy', '停止缓存')}
                >
                  停止缓存
                </Button>
                <Button
                  icon={<ReloadOutlined />}
                  disabled={!running}
                  loading={busyWith('restart-proxy')}
                  onClick={() => run('restart-proxy', '重启缓存')}
                >
                  重启缓存
                </Button>
              </Flex>

              <Divider style={{ margin: '2px 0' }}>维护</Divider>

              <Flex gap={10} wrap="wrap">
                <Button danger icon={<DatabaseOutlined />} loading={busyWith('clear-cache')} onClick={onClear}>
                  清空缓存
                </Button>
                <Button icon={<GlobalOutlined />} disabled={!running} onClick={() => run('open-stats', '打开统计页')}>
                  打开统计页
                </Button>
                <Button icon={<FileTextOutlined />} onClick={() => run('open-log', '打开日志')}>
                  用记事本打开日志
                </Button>
              </Flex>
            </Space>
          </Card>
        </Col>

        <Col xs={24} lg={14}>
          <Card
            title={<Space><CloudServerOutlined />运行明细</Space>}
            style={CARD}
            styles={{ body: { padding: 18 } }}
          >
            <Descriptions column={{ xs: 1, md: 2 }} size="small" colon={false}>
              <Descriptions.Item label="上游出口">{st?.upstream || '—'}</Descriptions.Item>
              <Descriptions.Item label="缓存目录">
                <Text copyable style={{ fontSize: 12 }}>{status?.paths?.cacheDir || '—'}</Text>
              </Descriptions.Item>
              <Descriptions.Item label="本地读盘">{fmtBytes(st?.bytesFromCache)}</Descriptions.Item>
              <Descriptions.Item label="外网下载">{fmtBytes(st?.bytesFromNetwork)}</Descriptions.Item>
              <Descriptions.Item label="魔改 / 预检 / 旧副本">
                {st ? `${st.overrides} / ${st.preflights} / ${st.stale}` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="淘汰 / 闲置 / 未入库">
                {st ? `${st.cache.evictions} / ${st.cache.idleEvictions} / ${st.missNoStore}` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="复用 / 新建 / 重试">
                {st ? `${latency.reuse ?? 0} / ${latency.newConn ?? 0} / ${latency.retries ?? 0}` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="完整性校验 / 布局">
                {st ? `${st.cache.verifyIntegrity ? '开' : '关'} / ${st.cache.layout}` : '—'}
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card
            title={<Space><InfoCircleOutlined />说明</Space>}
            style={{ ...CARD, marginTop: 16 }}
            styles={{ body: { padding: 18 } }}
          >
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
              · <b>命中率</b>只统计可缓存的素材请求；<b>透传</b>是动态接口（<Text code>/rest/</Text>、<Text code>.json</Text>），按设计不缓存，不参与命中率
            </Paragraph>
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 6 }}>
              · 素材第一次加载必然是「回源」，第二次才可能命中——刚清完缓存或刚更新的那一轮命中率天然偏低
            </Paragraph>
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              · 魔改素材：把文件命名为 <Text code>原名_ap.后缀</Text> 放进缓存目录对应路径，进游戏 Ctrl+F5 一次
            </Paragraph>
          </Card>
        </Col>
      </Row>

      <Card
        title={<Space><FileTextOutlined />实时日志<Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>runtime\logs\proxy.log</Text></Space>}
        style={{ ...CARD, marginTop: 16 }}
        styles={{ body: { padding: 12 } }}
        extra={
          <Space size={12} wrap>
            <Segmented
              size="small"
              value={logFilter}
              onChange={setLogFilter}
              options={Object.keys(FILTERS)}
            />
            <Space size={6}>
              <Text type="secondary" style={{ fontSize: 12 }}>自动刷新</Text>
              <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
            </Space>
          </Space>
        }
      >
        <Table
          size="small"
          rowKey="key"
          columns={COLUMNS}
          dataSource={visibleRows}
          pagination={false}
          scroll={{ y: 320 }}
          locale={{ emptyText: '（还没有日志）' }}
        />
      </Card>
    </div>
  );
}
