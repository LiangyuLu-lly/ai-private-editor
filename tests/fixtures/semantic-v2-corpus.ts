export type SemanticV2CorpusCase = {
  name: string;
  input: string;
  expected: readonly { kind: "person_name" | "address"; value: string }[];
};

// Evaluation-only synthetic cases. Keep these values out of the local training corpus.
export const SEMANTIC_V2_CORPUS: readonly SemanticV2CorpusCase[] = [
  {
    name: "spaced name is one atomic replacement",
    input: "麻烦联系张 默 言处理。",
    expected: [{ kind: "person_name", value: "张 默 言" }],
  },
  {
    name: "traditional double surname",
    input: "客戶歐陽娜娜會跟進。",
    expected: [{ kind: "person_name", value: "歐陽娜娜" }],
  },
  {
    name: "variation selectors preserve source span",
    input: "收件人是张\u2066默\uFE0F言，下午送达。",
    expected: [{ kind: "person_name", value: "张\u2066默\uFE0F言" }],
  },
  {
    name: "minority name with action context",
    input: "后续由阿不都热西提负责。",
    expected: [{ kind: "person_name", value: "阿不都热西提" }],
  },
  {
    name: "direct request with confirmation action",
    input: "请张默言确认预算。",
    expected: [{ kind: "person_name", value: "张默言" }],
  },
  {
    name: "handoff wording with review action",
    input: "让欧阳娜娜审核合同。",
    expected: [{ kind: "person_name", value: "欧阳娜娜" }],
  },
  {
    name: "campus address without province",
    input: "资料放在北京市海淀区中关村软件园二期3号楼1201。",
    expected: [{ kind: "address", value: "北京市海淀区中关村软件园二期3号楼1201" }],
  },
  {
    name: "traditional address",
    input: "請寄到臺北市信義區松仁路100號12樓。",
    expected: [{ kind: "address", value: "臺北市信義區松仁路100號12樓" }],
  },
  {
    name: "labeled address",
    input: "地址是上海市浦东新区世纪大道88号，到了联系我。",
    expected: [{ kind: "address", value: "上海市浦东新区世纪大道88号" }],
  },
  { name: "organization is not a person", input: "请联系华为处理云服务故障。", expected: [] },
  { name: "job title is not a person", input: "请联系张总确认预算。", expected: [] },
  // 同 semantic-review-corpus.ts 里的同类用例：无锚词的完整地址改为进入确认流程。
  // 跨度到 `88号` 为止，`附近开了新店` 由 ADDRESS_TAIL_PATTERN 剪掉。
  {
    name: "anchor-free full address is offered for confirmation",
    input: "上海市浦东新区世纪大道88号附近开了新店。",
    expected: [{ kind: "address", value: "上海市浦东新区世纪大道88号" }],
  },
];
