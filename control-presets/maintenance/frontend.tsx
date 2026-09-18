import type { FrontendPageProps } from '../../src/frontend/index.js';
import { OperationStatus, useOperation } from '../shared/components.js';
function MaintenancePage({ runtime }: FrontendPageProps) {
  const action = useOperation(runtime);
  return <section><h2>Maintenance</h2><button disabled={action.busy} onClick={() => void action.run('package:update')}>Update package</button>{' '}<button disabled={action.busy} onClick={() => void action.run('server:restart')}>Restart agents</button><OperationStatus {...action} /></section>;
}
export default MaintenancePage;
