// 粉丝采集：只读自己账号的粉丝数，每天一次。平台后台自带趋势的（B站 90 天、小红书 30 天、视频号 7 天、知识站 30 天）顺手补历史。
import { evaluate, withTab, sleep } from './driver.mjs';
import { num } from './metrics.mjs';
import { db } from './db.mjs';
import { config } from './feishu.mjs';
import { SITE } from './site.mjs';

db.exec(`CREATE TABLE IF NOT EXISTS followers (day TEXT, platform TEXT, total INTEGER, gain INTEGER, loss INTEGER, source TEXT, collected_at TEXT, PRIMARY KEY (day, platform));`);
const dayOf = (d) => { const x = new Date(d); return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, '0')}-${String(x.getDate()).padStart(2, '0')}`; };
export const today = () => dayOf(Date.now());
const get = (u) => `fetch(${JSON.stringify(u)},{credentials:'include'}).then(r=>r.json())`;
// 视频号页面在 shadow DOM 里，按文字节点读
const SHADOW_TEXT = `(()=>{const R=document.querySelector('wujie-app')&&document.querySelector('wujie-app').shadowRoot;if(!R)return '';const w=document.createTreeWalker(R,NodeFilter.SHOW_TEXT);let s=[],x;while(x=w.nextNode()){const p=x.parentElement;if(p&&/STYLE|SCRIPT/.test(p.tagName))continue;const v=x.textContent.trim().replace(/\\s+/g,' ');if(v)s.push(v)}return s.join(' | ')})()`;

// 每个采集器返回 { total, history: [{ day, total?, net?, gain?, loss? }] }；history 里只有 net 的，由 fill() 从今天的总数往回推
export const followerCollectors = {
  async bilibili() {
    const r = await withTab('https://member.bilibili.com/platform/home', (t) => evaluate(t, `Promise.all([${get('/x/web/index/stat')},${get('/x/web/data/v2/overview/stat/graph?period=2&s_locale=zh_CN&type=fan')}]).then(([a,b])=>({total:a.data&&a.data.total_fans,inc:a.data&&a.data.incr_fans,tend:(b.data&&b.data.tendency)||[]}))`));
    return r && r.total != null && { total: r.total, todayNet: r.inc || 0, history: r.tend.map(x => ({ day: dayOf(x.date_key * 1000), net: x.total_inc })) };
  },
  async douyin() {
    const n = await withTab('https://creator.douyin.com/creator-micro/home', async (t) => { await sleep(3000); return evaluate(t, `${get('/web/api/media/user/info/')}.then(x=>x.user&&x.user.follower_count)`); });
    return n != null && { total: n, history: [] };
  },
  async xhs() {
    const r = await withTab('https://creator.xiaohongshu.com/statistics/fans-data', async (t) => { await sleep(3000); return evaluate(t, `${get('/api/galaxy/creator/data/fans/overall_new')}.then(x=>{const d=x.data.thirty,m=(a)=>Object.fromEntries((a||[]).map(i=>[i.date,i.count]));const g=m(d.rise_fans_list),l=m(d.leave_fans_list);return {total:d.fans_count,list:(d.fans_list||[]).map(i=>({date:i.date,total:i.count,gain:g[i.date],loss:l[i.date]}))}})`); });
    return r && r.total != null && { total: r.total, history: r.list.map(x => ({ day: dayOf(x.date), total: x.total, gain: x.gain ?? null, loss: x.loss ?? null })) };
  },
  async channels() {
    const text = await withTab('https://channels.weixin.qq.com/platform/statistic/follower', async (t) => { for (let i = 0; i < 8; i++) { await sleep(2000); const s = await evaluate(t, SHADOW_TEXT).catch(() => ''); if (/关注者总数 \| \d/.test(s) && /\d{4}\/\d+\/\d+ \|/.test(s)) return s; } return evaluate(t, SHADOW_TEXT); }, { wait: 9000 });
    const total = num(((text || '').match(/关注者总数 \| ([\d,.万]+)/) || [])[1]); if (total == null) return null;
    const history = [...text.matchAll(/(\d{4})\/(\d{1,2})\/(\d{1,2}) \| (-?[\d,]+) \| ([\d,]+) \| ([\d,]+) \| ([\d,]+)/g)].map(m => ({ day: `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`, total: num(m[7]), gain: num(m[5]), loss: num(m[6]) }));
    return { total, history };
  },
  async youtube() {
    const text = await withTab('https://studio.youtube.com/', async (t) => { for (let i = 0; i < 8; i++) { await sleep(2500); const s = await evaluate(t, `document.body.innerText`).catch(() => ''); if (/当前订阅人数|Current subscribers/.test(s)) return s; } return ''; }, { wait: 9000 });
    const total = num(((text || '').match(/(?:当前订阅人数|Current subscribers)\s*\n?\s*([\d,.]+\s*[万KM]?)/) || [])[1]);
    return total != null && { total, history: [] };
  },
  async x() {
    if (!config.xHandle) return null;
    const s = await withTab(`https://x.com/${config.xHandle}`, async (t) => { for (let i = 0; i < 6; i++) { await sleep(2000); const v = await evaluate(t, `(document.querySelector('a[href$="/verified_followers"],a[href$="/followers"]')||{}).innerText||''`).catch(() => ''); if (v) return v; } return ''; }, { wait: 9000 });
    const total = num((s || '').replace(/\n/g, ' ')); return total != null && { total, history: [] };
  },
  async instagram() {   // 读自己主页上的「×× 粉丝」（接口有频率限制，不调）
    const n = await withTab('https://www.instagram.com/', async (t) => {
      let u = null;
      for (let i = 0; i < 8 && !u; i++) { await sleep(2000); u = await evaluate(t, `(()=>{const i=[...document.querySelectorAll('a[href] img[alt]')].find(i=>/的头像|profile picture/i.test(i.alt)&&i.getBoundingClientRect().x<150);return i?i.closest('a').getAttribute('href'):null})()`).catch(() => null); }
      if (!u) return null;
      await evaluate(t, `(location.href=${JSON.stringify(u)},1)`);
      for (let i = 0; i < 8; i++) { await sleep(2500); const v = await evaluate(t, `(document.body.innerText.match(/([\\d,.]+\\s*[万KM]?)\\s*(?:粉丝|位粉丝|followers)/i)||[])[1]||''`).catch(() => ''); if (v) return v; }
      return null;
    }, { wait: 6000 });
    const total = num(n); return total != null && { total, history: [] };
  },
  async zsz() {   // 知识站的「粉丝」= 注册用户
    if (!SITE) return null;
    const r = await withTab(SITE.admin, (t) => evaluate(t, `${get(SITE.dashboardApi)}.then(x=>({total:x.funnel.totalRegistered,trend:x.registrationTrend||[]}))`));
    return r && r.total != null && { total: r.total, todayNet: (r.trend[r.trend.length - 1] || {}).count || 0, history: r.trend.slice(0, -1).map(x => ({ day: x.date, net: x.count, gain: x.count, loss: 0 })) };
  },
};

const up = db.prepare(`INSERT INTO followers (day, platform, total, gain, loss, source, collected_at) VALUES (?,?,?,?,?,?,?)
  ON CONFLICT(day, platform) DO UPDATE SET total=excluded.total, gain=COALESCE(excluded.gain, gain), loss=COALESCE(excluded.loss, loss), source=excluded.source, collected_at=excluded.collected_at`);
const has = db.prepare(`SELECT source FROM followers WHERE day=? AND platform=?`);

// 存今天的实测值；历史只补还没有实测值的日子
export function saveFollowers(platform, r) {
  const now = new Date().toISOString(), t = today();
  up.run(t, platform, r.total, null, null, 'live', now);
  let hist = (r.history || []).filter(h => h.day < t).sort((a, b) => a.day < b.day ? 1 : -1), n = 0;
  if (hist.length && hist[0].total == null) {   // 只有每日净增：从今天的总数往回推每天结束时的总数（今天的净增取平台给的当日数，没有就按 0 算）
    let run = r.total - (r.todayNet || 0); for (const h of hist) { h.total = run; run -= h.net || 0; }
  }
  for (const h of hist) { if (h.total == null || (has.get(h.day, platform) || {}).source === 'live') continue; up.run(h.day, platform, h.total, h.gain ?? (h.net > 0 ? h.net : null), h.loss ?? null, 'backfill', now); n++; }
  return n;
}
export async function collectFollowers(only, skip = []) {
  const out = {};
  for (const [p, fn] of Object.entries(followerCollectors)) {
    if ((only && !only.includes(p)) || skip.includes(p) || (config.platforms && !config.platforms.includes(p))) continue;   // config.platforms 只采列出的平台
    try { const r = await fn(); if (!r) { out[p] = '没读到'; continue; } const n = saveFollowers(p, r); out[p] = { total: r.total, backfilled: n }; }
    catch (e) { out[p] = '出错：' + e.message.slice(0, 80); }
  }
  return out;
}
