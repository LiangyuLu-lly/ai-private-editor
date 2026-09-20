export type SemanticModelKind = "person_name" | "address";

export type SemanticModelSample = {
  kind: SemanticModelKind;
  positive: boolean;
  context: string;
};

// Synthetic only. These examples are the training source for the compact local model.
export const SEMANTIC_MODEL_CORPUS: readonly SemanticModelSample[] = [
  { kind: "person_name", positive: true, context: "客户会跟进这件事" },
  { kind: "person_name", positive: true, context: "由跟进此事" },
  { kind: "person_name", positive: true, context: "请联系处理后续事项" },
  { kind: "person_name", positive: true, context: "由负责人处理后续事项" },
  { kind: "person_name", positive: true, context: "请同事联系确认安排" },
  { kind: "person_name", positive: true, context: "收件人负责签收样品" },
  { kind: "person_name", positive: true, context: "经理将在门店等候" },
  { kind: "person_name", positive: true, context: "请确认预算并回复" },
  { kind: "person_name", positive: true, context: "由同事审核合同" },
  { kind: "person_name", positive: true, context: "让联系人协助安排交付" },
  { kind: "person_name", positive: true, context: "收件人签字确认" },
  { kind: "person_name", positive: true, context: "請聯絡同事處理後續" },
  { kind: "person_name", positive: false, context: "项目会跟进这件事" },
  { kind: "person_name", positive: false, context: "系统负责人处理后续事项" },
  { kind: "person_name", positive: false, context: "北京市将举办开发者活动" },
  { kind: "person_name", positive: false, context: "产品经理功能说明" },
  { kind: "person_name", positive: false, context: "科技公司确认服务安排" },
  { kind: "person_name", positive: false, context: "客户总监参加行业会议" },
  { kind: "person_name", positive: false, context: "历史人物介绍页面" },
  { kind: "address", positive: true, context: "包裹放到前台" },
  { kind: "address", positive: true, context: "快递送往收件地址" },
  { kind: "address", positive: true, context: "上门取件请到楼下" },
  { kind: "address", positive: true, context: "样品寄到门店签收" },
  { kind: "address", positive: true, context: "外卖送到小区门口" },
  { kind: "address", positive: true, context: "请前往参加会议" },
  { kind: "address", positive: true, context: "会议地点在附近" },
  { kind: "address", positive: true, context: "今天去办事" },
  { kind: "address", positive: true, context: "地址在园区楼下" },
  { kind: "address", positive: true, context: "派送至收货地点" },
  { kind: "address", positive: true, context: "导航到办公地点" },
  { kind: "address", positive: true, context: "請寄到收件地址" },
  { kind: "address", positive: false, context: "北京市将举办开发者活动" },
  { kind: "address", positive: false, context: "公司位于行业前列" },
  { kind: "address", positive: false, context: "项目路线需要重新评审" },
  { kind: "address", positive: false, context: "城市更新工作报告" },
  { kind: "address", positive: false, context: "附近门店开展促销活动" },
  { kind: "address", positive: false, context: "园区服务方案正在评审" },
];
