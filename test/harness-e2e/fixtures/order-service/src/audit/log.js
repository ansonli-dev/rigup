export const auditLog = [];

export function recordEvent(type, payload) {
  auditLog.push({type, ...payload});
}
