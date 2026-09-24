import test from 'node:test';
import assert from 'node:assert/strict';
import { balanceQuery, fetchBalance } from '../src/api-balance.ts';
import { quotaDisplay } from '../src/account-quota.ts';
import { newProfile } from '../src/types.ts';

const response = (data: unknown, status=200) => (async () => Response.json(data,{status})) as typeof fetch;
const signal = () => new AbortController().signal;

test('Kimi reports available balance in regional currency without adding voucher and cash again',async()=>{
  for(const region of ['cn','ai']){
    const p={...newProfile('kimi'),baseURL:`https://api.moonshot.${region}/v1`};
    const result=await fetchBalance(p,'key',signal(),async(url,init)=>{
      assert.equal(url,p.baseURL+'/users/me/balance');assert.equal((init?.headers as any).Authorization,'Bearer key');
      return Response.json({code:0,status:true,data:{available_balance:5,cash_balance:-2,voucher_balance:5}});
    });
    assert.equal(result.balance?.values[0].remaining,5);assert.equal(result.balance?.values[0].currency,region==='cn'?'CNY':'USD');
  }
  await assert.rejects(fetchBalance(newProfile('kimi'),'key',signal(),response({code:1,status:false,data:{available_balance:100}})),/有效余额/);
});

test('MiniMax keeps cash and subscription queries separate and binds credentials to official hosts',async()=>{
  const p={...newProfile('minimax'),model:'MiniMax-M3'};
  assert.equal(balanceQuery(p)?.url,'https://api.minimax.cn/account/query_balance');
  assert.equal(balanceQuery({...p,billingMode:'token-plan'})?.url,'https://api.minimax.cn/v1/token_plan/remains');
  assert.equal(balanceQuery({...p,baseURL:'https://api.minimax.cn.evil.example/v1'}),undefined);
  assert.equal(balanceQuery({...p,baseURL:'https://api.minimax.cn:8443/v1'}),undefined);
  const quota=await fetchBalance(p,'key',signal(),async(_url,init)=>{
    assert.equal((init?.headers as any).Authorization,'Bearer key');assert.equal((init?.headers as any)['x-api-key'],undefined);assert.equal(init?.body,undefined);
    return Response.json({base_resp:{status_code:0},available_amount:'9',cash_balance:'2',voucher_balance:'7',credit_balance:'0',owed_amount:'0'});
  });
  assert.equal(quotaDisplay(quota,p.protocol,p.model).text,'¥9.00');
  await assert.rejects(fetchBalance(p,'test-secret',signal(),response({base_resp:{status_code:1004,status_msg:'invalid key'}})),/invalid key/);
});

test('MiniMax plan uses explicit percentages, reset windows and weekly boosts, not countdown or ambiguous counts',async()=>{
  const p={...newProfile('minimax'),billingMode:'token-plan' as const,model:'MiniMax-M3'};
  const general={model_name:'general',current_interval_remaining_percent:0,current_weekly_remaining_percent:80,weekly_boost_permille:1500,end_time:1800000000000,weekly_end_time:1800100000000,current_interval_usage_count:99,remains_time:999999};
  const quota=await fetchBalance(p,'key',signal(),response({model_remains:[{model_name:'video',current_interval_remaining_percent:99},general]}));
  assert.equal(quota.balance,undefined);assert.deepEqual(quota.groups[0].windows,[{label:'5h',remaining:0,resetsAt:1800000000000},{label:'week',remaining:120,resetsAt:1800100000000}]);
  assert.equal(quotaDisplay(quota,p.protocol,p.model).text,'5h: 0% · week: 120%');
  for(const rows of [[{model_name:'video',current_interval_remaining_percent:100}],[{model_name:'general',current_interval_usage_count:100,current_interval_total_count:200}],[{...general,current_interval_remaining_percent:'50'}]])await assert.rejects(fetchBalance(p,'key',signal(),response({model_remains:rows})),/MiniMax/);
});

test('balance adapters use actual service origins; custom queries cannot send keys to another origin',()=>{
  assert.equal(balanceQuery(newProfile('deepseek'))?.url,'https://api.deepseek.com/user/balance');
  assert.equal(balanceQuery(newProfile('openrouter'))?.url,'https://openrouter.ai/api/v1/credits');
  const p={...newProfile('openrouter'),baseURL:'https://example.com/v1'};
  assert.equal(balanceQuery(p),undefined);
  for(const path of ['//other.example/balance','/\\other.example/balance','https://other.example/balance'])assert.throws(()=>balanceQuery({...p,balanceQuery:{path,field:'data.balance',currency:'USD'}}));
  assert.equal(balanceQuery({...p,balanceQuery:{path:'/account/balance',field:'data.balance',currency:'USD'}})?.url,'https://example.com/account/balance');
});

test('DeepSeek returns monetary totals and identifies grants; requests contain no chat content and reject redirects',async()=>{
  const p=newProfile('deepseek');
  const quota=await fetchBalance(p,'test-secret',signal(),async(url,init)=>{
    assert.equal(url,'https://api.deepseek.com/user/balance');
    assert.equal(init?.method,'GET');assert.equal(init?.body,undefined);
    assert.equal(init?.redirect,'error');assert.equal(init?.credentials,'omit');
    assert.equal((init?.headers as any).Authorization,'Bearer test-secret');
    return Response.json({balance_infos:[{currency:'CNY',total_balance:'12.50',topped_up_balance:'10.00',granted_balance:'2.50'}]});
  });
  assert.equal(quota.balance?.values[0].remaining,12.5);
  assert.equal(quotaDisplay(quota,'chat','').text,'¥12.50');
  assert.match(quota.balance!.detail,/赠金：2.5/);
});

test('OpenRouter balance is credits minus usage, never the key spending limit',async()=>{
  const p=newProfile('openrouter');
  const quota=await fetchBalance(p,'key',signal(),response({data:{total_credits:100.5,total_usage:25.75,limit_remaining:999}}));
  assert.equal(quotaDisplay(quota,'chat','').text,'$74.75');
  const denied=await fetchBalance(p,'key',signal(),response({},403));
  assert.equal(denied.balance,undefined);assert.match(denied.notice!,/无余额查询权限/);
  await assert.rejects(fetchBalance(p,'key',signal(),response({data:{limit_remaining:999}})),/有效金额/);
});

test('custom balances preserve zero and negative amounts, reject missing data and redact credentials',async()=>{
  const p={...newProfile('custom'),baseURL:'https://example.com/v1',balanceQuery:{path:'/balance',field:'data.balance',currency:'USD'}};
  for(const value of [0,'0','-1.25']){
    const quota=await fetchBalance(p,'key',signal(),response({data:{balance:value}}));
    assert.equal(quota.balance?.values[0].remaining,Number(value));
  }
  for(const value of [null,'',false,{},'unavailable'])await assert.rejects(fetchBalance(p,'key',signal(),response({data:{balance:value}})),/有效金额/);
  await assert.rejects(fetchBalance(p,'key',signal(),response({data:{}})),/找不到/);
  await assert.rejects(fetchBalance(p,'test-secret',signal(),async()=>{throw Error('Network test-secret');}),(error:Error)=>!error.message.includes('test-secret'));
});
