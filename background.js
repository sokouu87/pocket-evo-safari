import '../assets/background.js';
import { createBroker, trustedExtensionPage } from './broker.js';

const broker = createBroker(chrome);
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!['pocket-evo-chrome-fetch', 'pocket-evo-chrome-ping'].includes(message?.type)) return false;
  if (!trustedExtensionPage(sender, chrome.runtime)) {
    respond({ ok: false, error: '请求来源无效' });
    return false;
  }
  if (message.type === 'pocket-evo-chrome-ping') {
    broker.ready.then(() => respond({ ok: true }), () => respond({ ok: false, error: 'Chrome 请求规则初始化失败' }));
    return true;
  }
  Promise.resolve().then(() => broker.request(message)).then(
    (response) => respond({ ok: true, response }),
    () => respond({ ok: false, error: 'Chrome 请求失败，请检查站点权限、登录信息和连接状态' }),
  );
  return true;
});
