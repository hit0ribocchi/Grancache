import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert, Button, Card, Col, Descriptions, Divider, Flex, Modal, Row, Space,
  Statistic, Switch, Tag, Tooltip, Typography, message,
} from 'antd';
import {
  CloudServerOutlined, DatabaseOutlined, FileTextOutlined, GlobalOutlined,
  PlayCircleOutlined, ReloadOutlined, RocketOutlined, StopOutlined,
  ThunderboltOutlined,
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

export default function App() {
  const [status, setStatus] = useState(null);
  const [err, setErr] = useState(null);
  const [log, setLog] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [busy, setBusy] = useState(null);
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
      const r = await api('/api/log?lines=150');
      setLog(r.text || '');
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

  const running = !!status?.proxy?.running;
  const st = status?.proxy?.stats || null;
  const busyWith = (action) => busy === action;

  const onClear = () =>
    modal.confirm({
      title: '清空素材缓存？',
      content: '会删掉缓存对象（_ap 魔改文件保留）。下次进游戏需要重新下载素材。',
      okText: '确认清空',
      cancelText: '取消',
      okButtonProps: { danger: true },
      onOk: () => run('clear-cache', '清空缓存'),
    });

  const header = useMemo(
    () => (
      <Flex align="center" justify="space-between" wrap="wrap" gap={12}>
        <Space size={12} align="center">
          <ThunderboltOutlined style={{ fontSize: 26, color: '#7ee787' }} />
          <div>
            <Title level={4} style={{ margin: 0 }}>
              Grancache · 碧蓝幻想缓存代理
            </Title>
            <Text type="secondary" style={{ fontSize: 12 }}>
              GBF 缓存代理 ｜ 一键启动 = 起缓存 + 用带缓存的配置打开 Chrome 进游戏；也可以只开关缓存
            </Text>
          </div>
        </Space>
        <Space size={10}>
          <Tag color={running ? 'success' : 'default'} style={{ fontSize: 13, padding: '3px 10px' }}>
            {running ? `● 运行中 · PID ${st?.pid ?? status?.paths?.pid ?? '?'}` : '● 已停止'}
          </Tag>
          <Tooltip title="立即刷新">
            <Button
              icon={<ReloadOutlined />}
              onClick={() => {
                refresh();
                refreshLog();
              }}
            />
          </Tooltip>
        </Space>
      </Flex>
    ),
    [running, st, status, refresh, refreshLog]
  );

  return (
    <div style={{ minHeight: '100vh', background: '#0f1115', padding: 20 }}>
      {msgHolder}
      {modalHolder}
      <Card style={{ background: '#161b22', borderColor: '#30363d', marginBottom: 16 }} styles={{ body: { padding: 18 } }}>
        {header}
      </Card>

      {err && (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 16 }}
          message="面板连不上本地控制服务"
          description={err}
        />
      )}

      <Row gutter={[16, 16]}>
        <Col xs={24} lg={15}>
          <Card title="操作" style={{ background: '#161b22', borderColor: '#30363d' }}>
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

          <Card
            title={
              <Space>
                <FileTextOutlined />
                实时日志（runtime\logs\proxy.log）
              </Space>
            }
            style={{ background: '#161b22', borderColor: '#30363d', marginTop: 16 }}
            extra={
              <Space>
                <Text type="secondary" style={{ fontSize: 12 }}>
                  自动刷新
                </Text>
                <Switch size="small" checked={autoRefresh} onChange={setAutoRefresh} />
              </Space>
            }
          >
            <pre
              style={{
                margin: 0,
                maxHeight: 280,
                overflow: 'auto',
                fontSize: 12,
                lineHeight: 1.6,
                background: '#0d1117',
                border: '1px solid #30363d',
                borderRadius: 6,
                padding: 10,
                color: '#c9d1d9',
                whiteSpace: 'pre-wrap',
              }}
            >
              {log || '（还没有日志）'}
            </pre>
          </Card>
        </Col>

        <Col xs={24} lg={9}>
          <Card title="缓存状态" style={{ background: '#161b22', borderColor: '#30363d' }}>
            <Row gutter={[12, 12]}>
              <Col span={12}>
                <Statistic title="请求" value={st?.requests ?? 0} />
              </Col>
              <Col span={12}>
                <Statistic title="命中率" value={st?.hitRate ?? 0} suffix="%" precision={1} />
              </Col>
              <Col span={12}>
                <Statistic title="命中数" value={st?.hits ?? 0} />
              </Col>
              <Col span={12}>
                <Statistic title="缓存占用" value={st?.cache?.megabytes ?? 0} suffix="MB" precision={1} />
              </Col>
              <Col span={12}>
                <Statistic title="对象数" value={st?.cache?.objects ?? 0} />
              </Col>
              <Col span={12}>
                <Statistic title="运行时长" value={fmtDuration(st?.uptimeSeconds)} />
              </Col>
            </Row>
            <Divider style={{ margin: '14px 0' }} />
            <Descriptions column={1} size="small">
              <Descriptions.Item label="上游出口">{st?.upstream || '—'}</Descriptions.Item>
              <Descriptions.Item label="魔改 / 预检 / 旧副本">
                {st ? `${st.overrides} / ${st.preflights} / ${st.stale}` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="淘汰 / 未入库">
                {st ? `${st.cache.evictions} / ${st.missNoStore}` : '—'}
              </Descriptions.Item>
              <Descriptions.Item label="缓存目录">
                <Text copyable style={{ fontSize: 12 }}>
                  {status?.paths?.cacheDir || '—'}
                </Text>
              </Descriptions.Item>
            </Descriptions>
          </Card>

          <Card
            title={
              <Space>
                <CloudServerOutlined />
                说明
              </Space>
            }
            style={{ background: '#161b22', borderColor: '#30363d', marginTop: 16 }}
          >
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              · <b>一键启动</b>：确保缓存在后台跑起来 + 打开带缓存配置的 Chrome 进游戏
            </Paragraph>
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
              · <b>不想用缓存时</b>：点“停止缓存”，浏览器就按普通网络直连；想再用点“启动缓存”
            </Paragraph>
            <Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 0 }}>
              · 魔改素材：把文件命名为 <Text code>原名_ap.后缀</Text> 放进缓存目录对应路径，进游戏 Ctrl+F5 一次
            </Paragraph>
          </Card>
        </Col>
      </Row>
    </div>
  );
}
