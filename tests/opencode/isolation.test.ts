import { expect, test } from 'bun:test';
import { prepareIsolatedLaunch, type Inspect } from './isolation';
import { requireOptIn } from './native-binary';

const root = '/tmp/opencode/owned-fixture';
const binary = '/test/install/@opencode+cli@2.2.5/node_modules/@opencode/cli/bin/opencode.exe';
const origin = 'http://127.0.0.1:23456';
const config = JSON.stringify({ model:'fixture-provider/fixture-model', update:'disable', share:'disabled', snapshots:false,
  providers:{'fixture-provider':{env:[],package:'@opencode/ai/providers/openai-compatible',settings:{baseURL:`${origin}/v1`,apiKey:'fixture-only'},models:{'fixture-model':{type:'chat',capabilities:{tools:true,input:['text'],output:['text']},limit:{context:131072,output:2048}}}}} });
const selectors = ['HOME','OPENCODE_TEST_HOME','XDG_CONFIG_HOME','XDG_DATA_HOME','XDG_CACHE_HOME','XDG_STATE_HOME','TMPDIR','OPENCODE_CONFIG_DIR'];
const paths = {...Object.fromEntries(selectors.map(key => [key,`${root}/${key}`])),OPENCODE_DB:`${root}/db/native.sqlite`,GIT_CONFIG_GLOBAL:`${root}/gitconfig`};
const input = {root,cwd:`${root}/workspace`,paths,config,providerOrigin:origin,password:'fixture-password',host:'127.0.0.1',port:0,hostEnvironment:{OPENCODE_TEST_BINARY:binary,SECRET:'must-not-propagate'}};
const inspect: Inspect = async path => path === '/etc/opencode' || path.endsWith('native.sqlite') ? 'missing' : path.endsWith('gitconfig') ? 'file' : 'directory';

test('native acceptance requires explicit opt in and a direct binary selector', () => {
  expect(() => requireOptIn({})).toThrow('OPENCODE_NATIVE_TEST');
  expect(() => requireOptIn({OPENCODE_NATIVE_TEST:'1'})).toThrow('OPENCODE_TEST_BINARY');
  expect(() => requireOptIn({OPENCODE_NATIVE_TEST:'1',OPENCODE_TEST_BINARY:'/usr/bin/opencode'})).toThrow('wrapper');
  expect(() => requireOptIn({OPENCODE_NATIVE_TEST:'1',OPENCODE_TEST_BINARY:`${root}/../wrapper`})).toThrow();
  expect(requireOptIn({OPENCODE_NATIVE_TEST:'1',OPENCODE_TEST_BINARY:binary})).toBe(binary);
});

test('guard constructs a fresh environment and fails closed on unsafe fixture inputs', async () => {
  const spec = await prepareIsolatedLaunch(input,inspect);
  expect(spec.args).toEqual(['serve','--hostname','127.0.0.1','--port','0']);
  expect(spec.env.SECRET).toBeUndefined();
  expect(spec.env.OPENCODE_DISABLE_MODELS_FETCH).toBe('1');
  expect(spec.env.GIT_CONFIG_NOSYSTEM).toBe('1');
  await expect(prepareIsolatedLaunch({...input,root:'/tmp/not-approved'},inspect)).rejects.toThrow();
  await expect(prepareIsolatedLaunch({...input,host:'0.0.0.0'},inspect)).rejects.toThrow();
  await expect(prepareIsolatedLaunch({...input,paths:{...paths,HOME:'/home/user'}},inspect)).rejects.toThrow();
  await expect(prepareIsolatedLaunch({...input,config:config.replace(origin,'https://example.com')},inspect)).rejects.toThrow();
  await expect(prepareIsolatedLaunch({...input,config:JSON.stringify({...JSON.parse(config),mcp:{}})},inspect)).rejects.toThrow();
  await expect(prepareIsolatedLaunch(input,async path => path === '/etc/opencode' ? 'error' : inspect(path))).rejects.toThrow();
  await expect(prepareIsolatedLaunch(input,async path => path === `${root}/HOME` ? 'symlink' : inspect(path))).rejects.toThrow();
});
