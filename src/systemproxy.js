'use strict';

/**
 * Windows 系统代理（PAC）：让"已经开着的浏览器"也走缓存。
 *
 * 只给 playMode 启动的那个 Chrome 加 --proxy-pac-url 是不够的 —— 已经开着的浏览器
 * 完全不知道有代理存在。把 PAC 挂到系统代理上，所有读 WinINet 设置的浏览器都会按
 * PAC 分流；而 PAC 只把碧蓝幻想的域名指向本地缓存，其它流量照旧交给原来的出口，
 * 所以不会影响别的应用。
 *
 * 只动当前用户（HKCU）Internet Settings 里的 **AutoConfigURL** 一个值：
 *   - 应用前先把原值快照到 runtime/system-proxy.json，之后 --stop / 下次启动都能还原
 *   - ProxyEnable / ProxyServer 一律不碰，避免和用户自己的代理软件打架
 *   - 改完调 InternetSetOption 通知系统"代理设置变了"，Chrome 才会立刻重新拉 PAC
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PS_KEY = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';

function psRun(script) {
  return String(
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      windowsHide: true,
    })
  );
}

/** 通知系统代理设置已变（否则 Chrome 可能要等很久才重新拉 PAC） */
const NOTIFY_PS = [
  "Add-Type -Namespace GcW -Name W -MemberDefinition '[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int opt, IntPtr buf, int len);'",
  '[GcW.W]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null',
  '[GcW.W]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null',
].join('\n');

/** 当前系统代理里和 PAC 有关的值 */
function readCurrent() {
  const out = psRun(
    [
      `$k = '${PS_KEY}'`,
      '$p = Get-ItemProperty -Path $k -ErrorAction SilentlyContinue',
      '[pscustomobject]@{',
      '  autoConfigUrl = [string]$p.AutoConfigURL',
      '  proxyEnable   = [int]$p.ProxyEnable',
      '  proxyServer   = [string]$p.ProxyServer',
      '} | ConvertTo-Json -Compress',
    ].join('\n')
  );
  try {
    return JSON.parse(out.trim());
  } catch {
    return { autoConfigUrl: '', proxyEnable: 0, proxyServer: '' };
  }
}

class SystemProxy {
  constructor({ stateFile }) {
    this.stateFile = stateFile;
  }

  /** 我们是不是正接管着系统代理（有快照文件就算） */
  isApplied() {
    return fs.existsSync(this.stateFile);
  }

  appliedPacUrl() {
    try {
      return JSON.parse(fs.readFileSync(this.stateFile, 'utf8')).pacUrl || null;
    } catch {
      return null;
    }
  }

  /**
   * 把系统代理的 PAC 指向我们。已经挂过同一个 PAC 就什么都不做（幂等）。
   * @param {string} pacUrl
   * @param {number} ownerPid 这次接管属于哪个进程（0 = 说不清，别自动清理）
   * @returns {{applied: boolean, reason: string, previous?: object}}
   */
  apply(pacUrl, ownerPid = 0) {
    const current = readCurrent();
    if (this.isApplied() && current.autoConfigUrl === pacUrl) {
      return { applied: true, reason: 'already' };
    }
    // 先把原值存下来：进程被强杀时也能靠这个还原
    fs.mkdirSync(path.dirname(this.stateFile), { recursive: true });
    fs.writeFileSync(
      this.stateFile,
      JSON.stringify({ pacUrl, ownerPid, previous: current, at: new Date().toISOString() }, null, 2)
    );
    psRun(
      [
        `Set-ItemProperty -Path '${PS_KEY}' -Name AutoConfigURL -Value '${pacUrl}' -Type String`,
        NOTIFY_PS,
      ].join('\n')
    );
    return { applied: true, reason: 'set', previous: current };
  }

  /**
   * 快照里记的那个进程还在不在。
   * 被强杀（TerminateProcess）时进程没机会还原，系统里就会留一个指向死端口的 PAC；
   * 浏览器拿不到 PAC 只能全走直连，等于把用户原本的代理绕掉了 —— 必须能自愈。
   * @returns {boolean} true = 记录里的进程已经没了（该还原）
   */
  ownerDead() {
    try {
      const snap = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
      const pid = Number(snap.ownerPid || 0);
      if (!pid) return false; // 说不清归属就不动，免得误清掉别人正在用的接管
      process.kill(pid, 0); // 不抛异常 = 还活着
      return false;
    } catch (err) {
      // ESRCH = 进程不存在；其它错误（权限等）保守处理，不动
      return err && err.code === 'ESRCH';
    }
  }

  /**
   * 还原应用前的设置。没接管过就什么都不做。
   * @returns {{restored: boolean, reason: string, previous?: object}}
   */
  restore() {
    if (!this.isApplied()) return { restored: false, reason: 'not-applied' };
    let snap = null;
    try {
      snap = JSON.parse(fs.readFileSync(this.stateFile, 'utf8'));
    } catch {
      /* 快照坏了：至少把 AutoConfigURL 清掉，别把浏览器钉死在一个连不上的 PAC 上 */
    }
    const prev = (snap && snap.previous) || {};
    const hadUrl = typeof prev.autoConfigUrl === 'string' && prev.autoConfigUrl.length > 0;
    psRun(
      [
        hadUrl
          ? `Set-ItemProperty -Path '${PS_KEY}' -Name AutoConfigURL -Value '${prev.autoConfigUrl}' -Type String`
          : `Remove-ItemProperty -Path '${PS_KEY}' -Name AutoConfigURL -ErrorAction SilentlyContinue`,
        NOTIFY_PS,
      ].join('\n')
    );
    try {
      fs.unlinkSync(this.stateFile);
    } catch {
      /* 删不掉也无所谓，下次还原还是按快照来 */
    }
    return { restored: true, reason: hadUrl ? 'restored-previous' : 'cleared', previous: prev };
  }

  /** 给面板看的当前状态 */
  status() {
    return {
      applied: this.isApplied(),
      pacUrl: this.appliedPacUrl(),
      autoConfigUrl: this.isApplied() ? readCurrent().autoConfigUrl : null,
    };
  }
}

module.exports = { SystemProxy, readCurrent };
