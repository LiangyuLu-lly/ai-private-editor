export type SemanticReviewCorpusCase = {
  name: string;
  input: string;
  expected: readonly { kind: "person_name" | "address"; value: string }[];
};

export const SEMANTIC_REVIEW_CORPUS: readonly SemanticReviewCorpusCase[] = [
  // 措辞刻意不同于训练语料的上下文骨架："客户…会跟进这件事"去掉姓名后与训练
  // 上下文逐字相同，会让语义隔离检查失去意义。见 semantic-training-separation.test.ts。
  { name: "customer handoff", input: "客户张默言会尽快跟进。", expected: [{ kind: "person_name", value: "张默言" }] },
  { name: "spaced name with honorific", input: "麻烦请联系 张 小明老师确认交付。", expected: [{ kind: "person_name", value: "张 小明" }] },
  { name: "colon self introduction", input: "我叫：张默言，今天由我处理。", expected: [{ kind: "person_name", value: "张默言" }] },
  { name: "colleague wording", input: "这是我同事张默言，他会跟进。", expected: [{ kind: "person_name", value: "张默言" }] },
  { name: "traditional name", input: "客户張小明会跟进。", expected: [{ kind: "person_name", value: "張小明" }] },
  { name: "middle-dot name", input: "客户张·默言会跟进。", expected: [{ kind: "person_name", value: "张·默言" }] },
  { name: "full address delivery", input: "请把合同寄到广东省深圳市南山区科技园科苑路15号B座1203室。", expected: [{ kind: "address", value: "广东省深圳市南山区科技园科苑路15号B座1203室" }] },
  { name: "home address wording", input: "家住西安市碑林区友谊西路128号，今天不在。", expected: [{ kind: "address", value: "西安市碑林区友谊西路128号" }] },
  { name: "short municipality address", input: "在上海浦东世纪大道88号碰面。", expected: [{ kind: "address", value: "上海浦东世纪大道88号" }] },
  { name: "unicode-control name", input: "客户王\u2066小明会跟进。", expected: [{ kind: "person_name", value: "王\u2066小明" }] },
  { name: "role is not a person", input: "客户经理会在门店签收。", expected: [] },
  { name: "landmark is not a person", input: "请联系王府井会处理。", expected: [] },
  { name: "grammar does not imply a person", input: "由于公司会跟进。", expected: [] },
  { name: "historical context is not a current person", input: "客户李白会参加历史展。", expected: [] },
  // 政策变更（有意，非静默）：无投递锚词的完整地址现在也进入确认流程。
  // 此前这里的期望是 []，因为地址只在 `寄到`/`家住` 这类锚词之后才扫描。四个评测集上
  // "无锚词地址"因此一律 0.000，共 1298 条漏检。
  //
  // 度量依据（balanced 档，ml/reports/generated/ts-baseline/address-delta.txt）：
  // 精确率在每个集上都**上升**——blind-probe 0.9226→0.9661、semantic-v2 0.8280→1.0000、
  // sift 0.8513→0.8776；1000 条真实机构名负例的污染率 0.90%→0.00%。
  // 且这些候选带 requiresConfirmation，走的是"问用户"而不是"静默替换"。
  { name: "anchor-free full address is offered for confirmation", input: "上海市浦东新区世纪大道88号附近开了新店。", expected: [{ kind: "address", value: "上海市浦东新区世纪大道88号" }] },
  { name: "unclosed code is excluded", input: "```text\n客户王小明会跟进", expected: [] },
];
