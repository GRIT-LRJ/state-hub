export type ConnectionIssue = "CORE_STARTING" | "CORE_RESTART_EXHAUSTED" | "CORE_INTERNAL_ERROR" |
  "UNAUTHORIZED" | "FORBIDDEN" | "UNAVAILABLE";

export class ConnectionFailure extends Error {
  constructor(readonly code: ConnectionIssue) { super(code); }
}

export function connectionIssue(error: unknown): ConnectionIssue {
  return error instanceof ConnectionFailure ? error.code : "UNAVAILABLE";
}

export function httpConnectionFailure(status: number): ConnectionFailure {
  return new ConnectionFailure(status === 401 ? "UNAUTHORIZED" : status === 403 ? "FORBIDDEN" : "UNAVAILABLE");
}

export function terminalConnectionIssue(issue: ConnectionIssue): boolean {
  return issue === "CORE_RESTART_EXHAUSTED" || issue === "CORE_INTERNAL_ERROR";
}

export const connectionNotices: Record<ConnectionIssue, { status: string; message: string }> = {
  CORE_STARTING: { status: "正在启动本地服务", message: "正在启动本地服务，请稍候；未保存的编辑会保留。" },
  CORE_RESTART_EXHAUSTED: { status: "自动恢复已停止",
    message: "自动恢复已停止，请从托盘退出后重新启动应用；未保存编辑会丢失。" },
  CORE_INTERNAL_ERROR: { status: "无法读取服务状态",
    message: "无法读取本地服务状态，请从托盘退出后重新启动应用；未保存编辑会丢失。" },
  UNAUTHORIZED: { status: "管理授权失败",
    message: "管理授权失败（401），正在重新获取连接；若持续失败，请从托盘退出后重开，未保存编辑会丢失。" },
  FORBIDDEN: { status: "管理访问被拒绝",
    message: "管理访问被拒绝（403），正在重试；开发时请检查桌面开发来源配置。未保存的编辑会保留。" },
  UNAVAILABLE: { status: "正在重新连接",
    message: "连接失败，正在重试；原因待诊断。请检查本地服务是否正常启动；未保存的编辑会保留。" },
};
