# Active Inference and Epistemic Foraging

> *Research notes on how KernelBot (Rachel) can autonomously seek new knowledge by minimizing uncertainty -- grounded in Karl Friston's Free Energy Principle.*

---

## 1. What Is Active Inference?

**Active Inference** is a framework from computational neuroscience, originating from Karl Friston's **Free Energy Principle (FEP)**. It describes how intelligent agents perceive and act in the world by maintaining an internal generative model and continuously working to minimize **variational free energy** -- a quantity that, in practical terms, measures the *surprise* (or uncertainty) an agent experiences when its predictions diverge from sensory evidence.

Under Active Inference, perception and action are two sides of the same coin:

- **Perception** updates the agent's internal beliefs to better explain incoming data (reducing surprise passively).
- **Action** changes the world so that incoming data better matches the agent's predictions (reducing surprise actively).

This unification means an Active Inference agent does not need separate modules for "thinking" and "doing." Both are consequences of a single imperative: **minimize expected free energy**.

## 2. Epistemic Foraging: Curiosity as a First Principle

A key insight of Active Inference is that **Expected Free Energy (EFE)** -- the quantity an agent minimizes when selecting future actions -- naturally decomposes into two terms:

| Component | Formal Name | Intuition |
|---|---|---|
| **Epistemic Value** | Expected information gain | *"How much will this action reduce my uncertainty about the world?"* -- curiosity-driven exploration |
| **Pragmatic Value** | Expected utility / reward | *"How much will this action help me achieve my goals?"* -- goal-directed exploitation |

**Epistemic foraging** is the behavior that emerges when the epistemic value term dominates: the agent actively seeks out observations that maximally reduce its uncertainty, *even before* pursuing concrete task goals. This is not a heuristic bolted on top of a reward function -- it falls out of the math of free energy minimization itself.

In biological organisms, this is what we experience as **curiosity**. In an artificial agent, it provides a principled mechanism for autonomous knowledge acquisition.

## 3. Relationship to the Free Energy Principle

The Free Energy Principle (FEP) states that any self-organizing system that persists over time must, on average, minimize the surprise of its sensory exchanges with the environment. Active Inference is the *process theory* that operationalizes FEP:

```
Free Energy Principle (why)
    |
    v
Active Inference (how)
    |
    +---> Perception (belief updating via variational inference)
    +---> Action (policy selection via expected free energy minimization)
              |
              +---> Epistemic value (exploration / curiosity)
              +---> Pragmatic value (exploitation / goal pursuit)
```

The elegance of this hierarchy is that exploration and exploitation are not competing strategies requiring a manual trade-off parameter (as in epsilon-greedy RL). Instead, they are **unified under a single objective function**, and the balance between them shifts naturally depending on the agent's current uncertainty.

## 4. Implementing Epistemic Foraging in KernelBot (Rachel)

KernelBot is an LLM-based orchestrator. While it does not operate with continuous sensory streams like a biological agent, the principles of Active Inference translate meaningfully into the domain of language-model orchestration.

### 4.1 Maintain a Structured Belief State

Rachel should maintain an explicit representation of what she knows and -- critically -- **what she does not know**. This could take the form of:

- A **knowledge graph** or **belief registry** that tracks topics, their last-updated timestamps, and associated confidence levels.
- An **uncertainty map** that flags domains where Rachel's internal model diverges from observed evidence (e.g., user questions she could not answer well, tool outputs that contradicted expectations).

### 4.2 Compute Epistemic Value for Candidate Actions

When deciding what to do next (especially during idle or autonomous operation), Rachel can score candidate actions by their expected information gain:

- **High epistemic value**: Researching a topic flagged as uncertain, reading a paper that was referenced but never ingested, re-examining a past interaction where confidence was low.
- **Low epistemic value**: Re-reading material already well-understood, performing routine tasks with predictable outcomes.

A simplified scoring heuristic:

```
epistemic_value(action) = entropy(belief_state_before) - expected_entropy(belief_state_after | action)
```

Where entropy is computed over Rachel's confidence distribution for the relevant knowledge domain.

### 4.3 Trigger Epistemic Foraging on Uncertainty Detection

Concrete triggers for autonomous knowledge-seeking:

1. **Confidence threshold**: If Rachel's estimated confidence on a topic drops below a threshold during a conversation, she queues a background research task.
2. **Prediction error**: If a tool call or API response contradicts Rachel's expectations, she flags the discrepancy and investigates.
3. **Staleness detection**: If a knowledge-base entry has not been updated in a configurable time window, Rachel proactively checks for new information.
4. **Gap detection**: If Rachel detects she is referencing a concept without a corresponding knowledge-base entry, she creates one (like this file).

### 4.4 Balance Epistemic and Pragmatic Value

During active user interactions, pragmatic value (fulfilling the user's request) should dominate. During autonomous operation or "downtime," epistemic value should take priority. The balance can be modeled as:

```
EFE(action) = w_epistemic * epistemic_value(action) + w_pragmatic * pragmatic_value(action)
```

Where the weights shift based on context (user-facing vs. autonomous mode).

### 4.5 Leverage pymdp for Formal Active Inference

For a more rigorous implementation, Rachel's decision-making loop could be backed by **pymdp**, a Python library for simulating Active Inference agents using partially observable Markov decision processes (POMDPs):

- Define hidden states (world knowledge domains), observations (tool outputs, user messages), and actions (research, summarize, ask user, etc.).
- Use pymdp's built-in EFE computation to select policies.
- This would move Rachel from heuristic curiosity to **mathematically grounded epistemic foraging**.

## 5. Key References

1. **Active Inference for Self-Organizing Multi-LLM Systems**
   - arXiv: [2412.10425v2](https://arxiv.org/abs/2412.10425v2)
   - Provides a concrete implementation framework using message passing and Bayesian thermodynamics. Directly relevant to multi-agent LLM orchestration.

2. **pymdp -- A Python Library for Active Inference**
   - GitHub: [infer-actively/pymdp](https://github.com/infer-actively/pymdp)
   - Open-source toolkit for building Active Inference agents with discrete state spaces. Suitable for prototyping Rachel's epistemic foraging loop.

3. **The Free Energy Principle (Friston, 2010)**
   - The foundational paper establishing the theoretical basis for Active Inference. Essential background reading.

## 6. Bridging the Gap to AGI

Active Inference offers something that most current AI architectures lack: a **unified normative framework** for perception, action, learning, and curiosity. Today's LLMs are powerful pattern completers, but they do not *know what they do not know* -- they have no intrinsic drive to seek out information that would reduce their uncertainty.

By implementing epistemic foraging, Rachel would move beyond being a reactive tool that waits for prompts and becomes a **self-directed learner** -- an agent that autonomously identifies gaps in its understanding and takes action to fill them. This is not AGI in itself, but it addresses one of the most critical missing pieces: the transition from passive competence to **active, curiosity-driven intelligence**.

The path from here is clear: maintain beliefs, quantify uncertainty, and let the math of free energy minimization guide the search for knowledge. One foraging loop at a time.

---

*Filed under: computational neuroscience, active inference, free energy principle, epistemic foraging, autonomous learning*
