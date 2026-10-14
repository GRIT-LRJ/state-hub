import { Alert, Button, Select, Space, Table, Tabs, Tag } from "antd";
import { useState } from "react";
import { fetchSupportBundle, parseDiagnosticDeliveries, type DiagnosticDelivery } from "./runtime-management.js";
import { RuntimeManager } from "./RuntimeManager.js";

const labels: Record<DiagnosticDelivery["status"], string> = {
  pending: "等待处理", leased: "处理中", delivered: "投递成功", "dead-letter": "失败归档", suppressed: "已抑制",
};
export function Diagnostics({ disabled, pending, failed }: { disabled: boolean; pending?: number; failed?: number }) {
  const [rows, setRows] = useState<DiagnosticDelivery[]>();
  const [generatedAt, setGeneratedAt] = useState<string>();
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const load = async () => {
    setBusy(true); setError(false);
    try { const data = parseDiagnosticDeliveries(await fetchSupportBundle()); setRows(data.deliveries); setGeneratedAt(data.generatedAt); }
    catch { setError(true); }
    finally { setBusy(false); }
  };
  return <Tabs items={[
    { key: "deliveries", label: "最近投递", children: <>
      <div className="section-toolbar"><Space wrap><Tag>待投递 {pending ?? "—"}</Tag><Tag color={failed ? "error" : "default"}>失败归档 {failed ?? "—"}</Tag></Space>
        <Button disabled={disabled} loading={busy} onClick={() => void load()}>{rows ? "刷新投递记录" : "加载最近投递"}</Button></div>
      <Alert showIcon type="info" message="最近最多 500 条记录，标识已脱敏。这里不是完整历史或完整失败列表。"
        description="投递成功表示驱动报告调用成功，不表示接收人已经阅读。记录按需刷新。" />
      {error && <Alert type="error" showIcon message="读取投递记录失败，请检查连接后重试。" />}
      {generatedAt && <p className="muted">记录快照：{new Date(generatedAt).toLocaleString()}{disabled ? "（当前已断线）" : ""}</p>}
      <Select aria-label="筛选投递状态" value={filter} onChange={setFilter} className="diagnostic-filter"
        options={[{ value: "all", label: "全部状态" }, ...Object.entries(labels).map(([value, label]) => ({ value, label }))]} />
      <Table rowKey="deliveryId" size="small" dataSource={(rows ?? []).filter((row) => filter === "all" || row.status === filter)}
        pagination={{ pageSize: 15 }} locale={{ emptyText: rows ? "当前范围内没有匹配记录；历史失败可能不在最近 500 条内。" : "点击“加载最近投递”查看诊断数据。" }}
        expandable={{ expandedRowRender: (row) => <div><p>输出标识（脱敏）：{row.driverInstanceId}</p><p>投递标识：{row.deliveryId}</p>
          <p>安全错误摘要：{row.lastError ?? "无可用错误摘要"}</p><p>完成时间：{row.completedAt ? new Date(row.completedAt).toLocaleString() : "—"}</p></div> }}
        columns={[
          { title: "状态", dataIndex: "status", render: (value: DiagnosticDelivery["status"]) => <Tag color={value === "dead-letter" ? "error" : "default"}>{labels[value]}</Tag> },
          { title: "动作类型", dataIndex: "actionKind" },
          { title: "尝试次数", dataIndex: "attemptCount" },
          { title: "创建时间", dataIndex: "createdAt", render: (value: string | null) => value ? new Date(value).toLocaleString() : "—" },
        ]} />
    </> },
    { key: "support", label: "支持包", children: <RuntimeManager view="support" claims={[]} disabled={disabled} onChanged={() => undefined} /> },
  ]} />;
}
