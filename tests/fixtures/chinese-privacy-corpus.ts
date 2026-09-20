import type { RedactionOptions } from "../../src/shared/detector.js";
import type { DetectionKind } from "../../src/shared/types.js";

export type ChinesePrivacyCorpusCase = {
  name: string;
  input: string;
  options?: RedactionOptions;
  expectedKinds: readonly DetectionKind[];
  unexpectedKinds?: readonly DetectionKind[];
};

export const CHINESE_PRIVACY_CASES: readonly ChinesePrivacyCorpusCase[] = [
  {
    name: "balanced profile recognizes a natural Chinese owner statement",
    input: "这个项目由张默言负责，请安排下周会议。",
    options: { detectionProfile: "balanced" },
    expectedKinds: ["person_name"],
  },
  {
    name: "balanced profile recognizes a natural delivery address statement",
    input: "请把材料寄送至陕西省西安市碑林区友谊西路128号。",
    options: { detectionProfile: "balanced" },
    expectedKinds: ["address"],
  },
  {
    name: "balanced profile recognizes an account expressed with a verb",
    input: "我的微信是 demo_wechat_01，方便时加我。",
    options: { detectionProfile: "balanced" },
    expectedKinds: ["account"],
  },
  {
    name: "explicit credential labels accept natural Chinese separators",
    input: "测试环境数据库密码是 synthetic-demo-secret。",
    expectedKinds: ["credential"],
  },
  {
    name: "balanced profile leaves code examples out of contextual detection",
    input: "```text\n我是张默言，住在北京市朝阳区\n```",
    options: { detectionProfile: "balanced" },
    expectedKinds: [],
  },
  {
    name: "conservative profile does not guess ordinary Chinese prose",
    input: "这个普通项目需要在下周完成评审。",
    expectedKinds: [],
  },
  {
    name: "known secret prefixes remain high-confidence in every profile",
    input: "请检查 glpat-0123456789abcdefghijkl。",
    expectedKinds: ["api_key"],
  },
  {
    name: "valid Chinese identity number",
    input: "证件信息：11010519491231002X。",
    expectedKinds: ["china_id"],
  },
  {
    name: "spaced mobile number",
    input: "我的手机号是 138 0013 8000。",
    expectedKinds: ["phone"],
  },
  {
    name: "full-width mobile number with invisible separators",
    input: "请联系 １３８\u200B００１３\u200D８０００。",
    expectedKinds: ["phone"],
  },
  {
    name: "email in a Chinese sentence",
    input: "请将回执发到 demo_user@example.test。",
    expectedKinds: ["email"],
  },
  {
    name: "checksum-valid bank card",
    input: "收款卡号 4111 1111 1111 1111。",
    expectedKinds: ["bank_card"],
  },
  {
    name: "valid unified social credit code",
    input: "统一社会信用代码：91110108MA01K12342。",
    expectedKinds: ["unified_social_credit_code"],
  },
  {
    name: "private network address",
    input: "服务节点位于 192.168.5.114。",
    expectedKinds: ["ipv4"],
  },
  {
    name: "local Windows path",
    input: "日志文件在 C:\\Users\\demo\\Desktop\\report.txt。",
    expectedKinds: ["local_path"],
  },
  {
    name: "colloquial self introduction",
    input: "我叫李舒雯，后续由我负责对接。",
    options: { detectionProfile: "balanced" },
    expectedKinds: ["person_name"],
  },
  {
    name: "colloquial contact request",
    input: "请找王小明，确认合同。",
    options: { detectionProfile: "balanced" },
    expectedKinds: ["person_name"],
  },
  {
    name: "colloquial address request",
    input: "麻烦把资料寄到上海市浦东新区世纪大道88号。",
    options: { detectionProfile: "balanced" },
    expectedKinds: ["address"],
  },
  {
    name: "colloquial WeChat account",
    input: "我的微信号是 demo_wechat_920514，收到请回。",
    options: { detectionProfile: "balanced" },
    expectedKinds: ["account"],
  },
  {
    name: "QQ account with explicit label",
    input: "QQ号：274891635。",
    expectedKinds: ["account"],
  },
  {
    name: "Chinese credential with punctuation in value",
    input: "数据库密码：alpha,beta；请勿外传。",
    expectedKinds: ["credential"],
  },
  {
    name: "quoted English password",
    input: 'password="alpha,beta"',
    expectedKinds: ["credential"],
  },
  {
    name: "full-width credential label with an invisible separator",
    input: "ｐａｓｓｗｏｒｄ＝ａｌｐｈａ\u200B，ｂｅｔａ",
    expectedKinds: ["credential"],
  },
  {
    name: "unquoted English password followed by another field",
    input: "password=alpha,beta, username=demo_user",
    expectedKinds: ["credential", "account"],
  },
  {
    name: "authorization bearer credential",
    input: "Authorization: Bearer synthetic-token-value",
    expectedKinds: ["credential"],
  },
  {
    name: "JSON secret field",
    input: '{"client_secret":"json-alpha,beta","scope":"demo"}',
    expectedKinds: ["credential"],
  },
  {
    name: "YAML API key field",
    input: "api_key: yaml-alpha-beta\nendpoint: https://example.test",
    expectedKinds: ["credential"],
  },
  {
    name: "database connection string",
    input: "连接串：postgresql://demo:secret@example.test:5432/app",
    expectedKinds: ["connection_string"],
  },
  {
    name: "private key block",
    input: "-----BEGIN PRIVATE KEY-----\nsynthetic-key\n-----END PRIVATE KEY-----",
    expectedKinds: ["private_key"],
  },
  {
    name: "OpenAI-style API key",
    input: "sk-proj-abcdefghijklmnopqrstuvwxyz1234567890ABCDEFGHIJ",
    expectedKinds: ["api_key"],
  },
  {
    name: "ordinary prose does not infer personal data",
    input: "这个普通项目需要在下周完成评审。",
    expectedKinds: [],
    unexpectedKinds: ["person_name", "address", "credential", "account"],
  },
  {
    name: "token word without an assignment is not a credential",
    input: "文档中解释 token 的生命周期和刷新机制。",
    expectedKinds: [],
    unexpectedKinds: ["credential", "access_token", "api_key"],
  },
  {
    name: "invalid Chinese identity number is left alone",
    input: "无效号 110105194912310021。",
    expectedKinds: [],
    unexpectedKinds: ["china_id", "bank_card"],
  },
  {
    name: "balanced contextual rules stay out of a code fence",
    input: "```text\n我是张默言，住在北京市朝阳区\n```",
    options: { detectionProfile: "balanced" },
    expectedKinds: [],
    unexpectedKinds: ["person_name", "address"],
  },
  {
    name: "high-entropy prose without a field label is not a credential",
    input: "本次演示字符串 synthetic-random-7f3a9c1d 仅用于 UI 占位。",
    expectedKinds: [],
    unexpectedKinds: ["credential", "api_key", "access_token"],
  },
];
