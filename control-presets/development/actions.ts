import sharedActions from '../shared/actions.js';
import maintenanceActions from '../maintenance/actions.js';
import { deploy } from './deployment.js';
import type { LocalAction } from '../../src/runtime/index.js';
import type { Payload } from '../lib/validation.js';
import { identifier, object, priority, text } from '../lib/validation.js';
import { executePrdAdd, executePrdPriorityUpdate, executePrdReset, listPrds } from './prd-service.js';

export const execution = 'worker';

const actions: Record<string, LocalAction> = {
  'prd:list': { validate: input => object(input, []), run: (_input, context) => listPrds(context) },
  'prd:add': {
    validate(input) {
      const data = object(input, ['id', 'title', 'specification', 'requirements', 'priority']);
      const specification = text(data, 'specification', false, 100000);
      const requirements = data.requirements ?? [];
      if (!Array.isArray(requirements) || requirements.length > 100 || requirements.some((value) => typeof value !== 'string' || !value.trim() || value.length > 10000 || value.includes('\0'))) throw new Error('Invalid requirements.');
      if (!specification && requirements.length === 0) throw new Error('Provide a specification or requirements.');
      return { id: identifier(data, 'id'), title: text(data, 'title'), specification, requirements, priority: priority(data, false) };
    },
    lockKey: 'repository-mutation',
    run: (input: Payload, context) => executePrdAdd(input, context),
  },
  'prd:reset': {
    validate(input) {
      const data = object(input, ['prdId', 'reason']);
      return { prdId: identifier(data, 'prdId'), reason: text(data, 'reason', false, 10000) };
    },
    lockKey: 'repository-mutation',
    run: (input: Payload, context) => executePrdReset(input, context),
  },
  'prd:priority': {
    validate(input) {
      const data = object(input, ['prdId', 'priority', 'reason']);
      return { prdId: identifier(data, 'prdId'), priority: priority(data), reason: text(data, 'reason', false, 10000) };
    },
    lockKey: 'repository-mutation',
    run: (input: Payload, context) => executePrdPriorityUpdate(input, context),
  },
  deploy: {
    validate: (input) => object(input, []),
    lockKey: 'repository-mutation',
    run: (_input, context) => context.runtime.withLock(() => deploy(context)),
  },
};

export default { ...sharedActions, ...actions, ...maintenanceActions };
