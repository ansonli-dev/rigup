// Workflow fixtures launch Git, hooks, npm and supervised Node processes. On
// monitored Windows hosts those successful operations can take 21–25 seconds.
// Keep these allowances local: runLiveCommand's explicit timeout and the
// process-tree leak/termination limits must not be scaled with them.
const windows=process.platform==='win32';
export const workflowCommandTimeoutMs=windows?60_000:15_000;
export const workflowGitBackendTimeoutMs=windows?30_000:10_000;
export const workflowObservationTimeoutMs=windows?30_000:10_000;
// An HTTP action can run a snapshot check plus Git reads. The CLI wrapper
// must outlive that request so the fixture can report its failure itself.
export const workflowRequestTimeoutMs=windows?120_000:15_000;
export const workflowClientTimeoutMs=windows?150_000:15_000;
