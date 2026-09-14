import React from 'react';
import { createRoot } from 'react-dom/client';
import { ConfigProvider, theme } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import App from './App.jsx';

createRoot(document.getElementById('root')).render(
  <ConfigProvider
    locale={zhCN}
    theme={{ algorithm: theme.darkAlgorithm, token: { colorPrimary: '#7ee787', borderRadius: 8, fontSize: 13 } }}
  >
    <App />
  </ConfigProvider>
);
