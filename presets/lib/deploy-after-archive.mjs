import { createFrontendRuntime } from '@asalaza6/autonomy-v2/frontend';

/** Optional development policy; execution stays in the configured control action. */
export async function deployAfterArchive(rootDir, archive) {
  if (!['archived', 'missing-source'].includes(archive?.status)) {
    return { status: 'skipped', reason: 'PRD archive did not complete' };
  }
  let runtime;
  try {
    const instance = await createFrontendRuntime({ rootDir });
    runtime = instance.runtime;
    if (instance.controls?.options.deployAfterArchive !== true) {
      return { status: 'skipped', reason: 'deployAfterArchive is disabled' };
    }
    let operation = await runtime.runAction('deploy', {});
    while (operation.status === 'running') {
      await new Promise(resolve => setTimeout(resolve, 100));
      operation = await runtime.getOperation(operation.id);
      if (!operation) throw new Error('Deployment operation disappeared.');
    }
    return operation.status === 'success'
      ? { status: 'deployed', result: operation.result }
      : { status: 'failed', error: operation.error, operationId: operation.id };
  } catch (error) {
    return { status: 'failed', error: error.message };
  } finally { runtime?.dispose(); }
}
