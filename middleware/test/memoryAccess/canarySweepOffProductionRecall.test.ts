// Memory-ACL plan step 3 — canary sweep, context memory `off`, with the
// production recall limits: the top few hits decide what the graph walk
// around them reaches (see canarySweepSuite.ts).
import { canarySweepSuite } from './canarySweepSuite.js';

canarySweepSuite(['off'], { recall: 'production' });
