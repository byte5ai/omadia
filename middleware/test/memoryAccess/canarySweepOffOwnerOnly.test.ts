// Memory-ACL plan step 6 — canary sweep, context memory `off`, with the
// documented owner-only setting (`KG_RECALL_TEAM_VISIBILITY=false`): team
// and public knowledge is then no one's but its owners'. Every other sweep
// runs today's default (on), under which the graph view's team rule
// (`graphNodeAccess.ts`) can be widened without any canary being forbidden.
import { canarySweepSuite } from './canarySweepSuite.js';

canarySweepSuite(['off'], { settings: { teamVisibility: false } });
