import { initializeCodex } from './codex-bridge.mjs';
initializeCodex().catch(error => {
  document.getElementById('status').textContent = error.message || 'ClearPane 初始化失败，请重新打开。';
  document.getElementById('status').classList.add('error');
});
