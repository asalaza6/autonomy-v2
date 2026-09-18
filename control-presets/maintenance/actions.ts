import type { LocalAction } from '../../src/runtime/index.js';
import { object } from '../lib/validation.js';
import { updatePackage } from './update.js';
export const execution = 'worker';
const actions: Record<string, LocalAction> = {
  'package:update': { validate: input => object(input, []), lockKey: 'repository-mutation', run: (_input, context) => updatePackage(context) },
  'server:restart': {
    validate: input => object(input, []), lockKey: 'repository-mutation',
    run: (_input, context) => context.capabilities.controlServer('server:restart', { json: true, detached: true }),
  },
};
export default actions;
