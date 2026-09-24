import test from 'node:test';
import assert from 'node:assert/strict';
import { codexQuota, antigravityQuota, quotaDisplay } from '../src/account-quota.ts';

test('Codex reports remaining quota from real used percentages without fabricating missing windows', () => {
  const quota=codexQuota({rateLimits:{primary:{usedPercent:99}},rateLimitsByLimitId:{codex:{primary:{usedPercent:25,windowDurationMins:300,resetsAt:100},secondary:{usedPercent:40,windowDurationMins:10080}},other:{primary:null,secondary:{usedPercent:null}}}});
  assert.equal(quota.groups.length,1);
  assert.deepEqual(quota.groups[0].windows,[{label:'5 小时',remaining:75,resetsAt:100000},{label:'每周',remaining:60}]);
  assert.match(quotaDisplay(quota,'codex-account','gpt-test').text,/75%.*60%/);
  assert.equal(codexQuota({rateLimits:{primary:{usedPercent:null}}}).groups.length,0);
  const weekly=codexQuota({rateLimits:{primary:null,secondary:{usedPercent:13,windowDurationMins:10080}}});
  assert.equal(quotaDisplay(weekly,'codex-account','gpt-test').text,'week: 87%');
  assert.equal(quotaDisplay(weekly,'codex-account','gpt-test').reset,'');
});
test('Antigravity uses the correct Gemini or third-party quota pool and reset times', () => {
  const quota=antigravityQuota('Gemini Models\tWeekly Limit Remaining\t80%\t2026-09-27T00:00:00Z\nGemini Models\tFive Hour Limit Remaining\t62.5%\t2026-09-20T18:00:00Z\nClaude and GPT models\tWeekly Limit Remaining\t20%\t2026-09-27T00:00:00Z');
  assert.equal(quotaDisplay(quota,'antigravity-account','gemini-3.8-flash-low').text,'5h: 62.5% · week: 80%');
  assert.equal(quotaDisplay(quota,'antigravity-account','claude-sonnet').text,'week: 20%');
  assert.equal(quota.groups[0].windows[0].resetsAt,Date.parse('2026-09-20T18:00:00Z'));
  assert.throws(()=>antigravityQuota('Authentication required'),/未返回/);
});

test('reset times follow the displayed quota windows in local time and preserve missing entries',()=>{
  const quota=codexQuota({rateLimits:{primary:{usedPercent:20,windowDurationMins:300,resetsAt:new Date(2026,8,20,23,30).getTime()/1000},secondary:{usedPercent:10,windowDurationMins:10080,resetsAt:new Date(2026,8,27,18,0).getTime()/1000}}});
  assert.deepEqual(quotaDisplay(quota,'codex-account','gpt-test'),{text:'5h: 80% · week: 90%',reset:'9/20 23:30 · 9/27 18:00'});
  delete quota.groups[0].windows[0].resetsAt;
  assert.equal(quotaDisplay(quota,'codex-account','gpt-test').reset,'— · 9/27 18:00');
  quota.groups.push({id:'other',name:'Other',windows:[{label:'每周',remaining:1,resetsAt:0}]});
  assert.equal(quotaDisplay(quota,'codex-account','gpt-test').reset,'— · 9/27 18:00');
});
