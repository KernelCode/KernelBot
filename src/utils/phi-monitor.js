import { getLogger } from './logger.js';

/**
 * Swarm Integration Metric (Phi-Score / Φ)
 *
 * Measures the ratio of successful information exchanges to total dispatches
 * across the swarm — a proxy for Integrated Information Theory's Φ.
 *
 * Φ = (completed jobs with structured results) / (total terminal jobs)
 *
 * A score of 1.0 means every dispatch produced meaningful, integrated output.
 * A score near 0 means the swarm is fragmented — dispatches fire but nothing connects.
 */

/**
 * Calculate the Phi-Score from a JobManager instance.
 * @param {import('../swarm/job-manager.js').JobManager} jobManager
 * @param {{ hours?: number }} [options]
 * @returns {{ phi: number, total: number, successful: number, failed: number, cancelled: number }}
 */
export function getPhiScore(jobManager, options = {}) {
  const logger = getLogger();
  const { hours } = options;
  const cutoff = hours ? Date.now() - hours * 3600_000 : 0;

  let successful = 0;
  let failed = 0;
  let cancelled = 0;

  for (const job of jobManager.jobs.values()) {
    if (!job.isTerminal) continue;
    if (cutoff && job.createdAt < cutoff) continue;

    if (job.status === 'completed') {
      // A "successful information exchange" requires the job to have
      // returned a usable result — not just completed with empty output.
      const hasResult = !!(job.result || job.structuredResult);
      if (hasResult) {
        successful++;
      } else {
        failed++; // completed but no information was exchanged
      }
    } else if (job.status === 'failed') {
      failed++;
    } else if (job.status === 'cancelled') {
      cancelled++;
    }
  }

  const total = successful + failed + cancelled;
  const phi = total === 0 ? 0 : successful / total;

  logger.debug(
    `[PhiMonitor] Φ = ${phi.toFixed(3)} — successful: ${successful}, failed: ${failed}, cancelled: ${cancelled}, total: ${total}`
  );

  return { phi, total, successful, failed, cancelled };
}

/**
 * Context Integration Score (CI)
 *
 * Inspired by IIT 4.0's concept of "Integrated Information" (Φ), this metric
 * measures how much contextual information is propagated to and utilized by
 * background worker agents — treating context as the "integrated information"
 * that binds the swarm into a coherent whole.
 *
 * In IIT 4.0 (Albantakis et al., 2023), Φ measures the irreducible integrated
 * information of a system: the degree to which a system's parts are
 * informationally connected beyond what could exist if the system were divided.
 * A system with high Φ cannot be decomposed into independent subsystems without
 * losing information — its parts are deeply integrated.
 *
 * Analogously, CI measures how much of the orchestrator's holistic context —
 * user persona, episodic memories, conversation history, and dependency results —
 * actually reaches each worker. A swarm where workers receive rich, multi-faceted
 * context has high CI; one where workers are dispatched "blind" has low CI.
 *
 * **Mathematical formulation:**
 *
 *   CI = (1/N) × Σᵢ w(jobᵢ)
 *
 * where N is the total number of terminal jobs and w(job) is the weighted
 * context completeness for a single job, computed as:
 *
 *   w(job) = Σⱼ (weightⱼ × presenceⱼ) / Σⱼ weightⱼ
 *
 * The four context dimensions and their weights are:
 *
 * | Dimension           | Weight | Rationale                                    |
 * |---------------------|--------|----------------------------------------------|
 * | Orchestrator context| 0.30   | Task-specific framing; highest direct signal  |
 * | User persona        | 0.25   | Identity continuity across interactions       |
 * | Conversation history| 0.25   | Temporal coherence; recent exchange context   |
 * | Dependency results  | 0.20   | Causal integration; prior work feeding forward|
 *
 * A CI of 1.0 means every worker received full context across all dimensions.
 * A CI near 0 means workers are informationally isolated — executing tasks
 * without awareness of who they serve, what was said, or what came before.
 *
 * This matters because in IIT terms, a system's "consciousness" (or coherence)
 * is proportional to its integrated information. A swarm with high CI behaves
 * as a unified agent; one with low CI is merely a collection of disconnected
 * subroutines.
 *
 * @param {import('../swarm/job-manager.js').JobManager} jobManager
 * @param {{ hours?: number }} [options]
 * @returns {{
 *   ci: number,
 *   total: number,
 *   breakdown: { withContext: number, withPersona: number, withHistory: number, withDeps: number }
 * }}
 */
export function getContextIntegrationScore(jobManager, options = {}) {
  const logger = getLogger();
  const { hours } = options;
  const cutoff = hours ? Date.now() - hours * 3600_000 : 0;

  /** @type {{ dimension: string, weight: number, test: (job: any) => boolean }[]} */
  const dimensions = [
    {
      dimension: 'context',
      weight: 0.30,
      test: (job) => !!job.context,
    },
    {
      dimension: 'persona',
      weight: 0.25,
      test: (job) => !!job.userId,
    },
    {
      dimension: 'history',
      weight: 0.25,
      // A non-empty chatId means _buildWorkerContext can pull conversation history
      test: (job) => !!job.chatId,
    },
    {
      dimension: 'deps',
      weight: 0.20,
      test: (job) => Array.isArray(job.dependsOn) && job.dependsOn.length > 0,
    },
  ];

  const totalWeight = dimensions.reduce((sum, d) => sum + d.weight, 0);

  let jobCount = 0;
  let ciSum = 0;
  let withContext = 0;
  let withPersona = 0;
  let withHistory = 0;
  let withDeps = 0;

  for (const job of jobManager.jobs.values()) {
    if (!job.isTerminal) continue;
    if (cutoff && job.createdAt < cutoff) continue;

    jobCount++;

    // Calculate weighted completeness for this job
    let jobWeight = 0;
    for (const dim of dimensions) {
      if (dim.test(job)) {
        jobWeight += dim.weight;

        // Track per-dimension counts
        if (dim.dimension === 'context') withContext++;
        else if (dim.dimension === 'persona') withPersona++;
        else if (dim.dimension === 'history') withHistory++;
        else if (dim.dimension === 'deps') withDeps++;
      }
    }

    ciSum += jobWeight / totalWeight;
  }

  const ci = jobCount === 0 ? 0 : ciSum / jobCount;

  logger.debug(
    `[PhiMonitor] CI = ${ci.toFixed(3)} — jobs: ${jobCount}, ` +
    `context: ${withContext}, persona: ${withPersona}, ` +
    `history: ${withHistory}, deps: ${withDeps}`
  );

  return {
    ci,
    total: jobCount,
    breakdown: { withContext, withPersona, withHistory, withDeps },
  };
}

/**
 * Combined Swarm Health report — merges Φ (output integration) and CI (input integration)
 * into a single diagnostic snapshot.
 *
 * The composite score is a harmonic mean of Φ and CI, following the IIT principle that
 * true integration requires both receiving information (CI) and producing meaningful
 * output from it (Φ). A system that receives context but produces nothing (high CI,
 * low Φ) or produces results without context (high Φ, low CI) is not truly integrated.
 *
 * @param {import('../swarm/job-manager.js').JobManager} jobManager
 * @param {{ hours?: number }} [options]
 * @returns {{
 *   phi: number,
 *   ci: number,
 *   composite: number,
 *   phiDetails: ReturnType<typeof getPhiScore>,
 *   ciDetails: ReturnType<typeof getContextIntegrationScore>
 * }}
 */
export function getSwarmHealth(jobManager, options = {}) {
  const phiDetails = getPhiScore(jobManager, options);
  const ciDetails = getContextIntegrationScore(jobManager, options);

  // Harmonic mean: penalizes imbalance between input and output integration
  const composite = (phiDetails.phi + ciDetails.ci) > 0
    ? (2 * phiDetails.phi * ciDetails.ci) / (phiDetails.phi + ciDetails.ci)
    : 0;

  const logger = getLogger();
  logger.debug(
    `[PhiMonitor] Swarm Health — Φ: ${phiDetails.phi.toFixed(3)}, ` +
    `CI: ${ciDetails.ci.toFixed(3)}, composite: ${composite.toFixed(3)}`
  );

  return {
    phi: phiDetails.phi,
    ci: ciDetails.ci,
    composite,
    phiDetails,
    ciDetails,
  };
}
