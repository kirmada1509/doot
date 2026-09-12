# Security And Privacy Rules

1. Plaintext phone numbers, locations, transcripts, model prompts, and audio never enter ordinary logs or traces.
2. All externally supplied webhooks enter an idempotent inbox before business transitions.
3. CALL-E webhook bodies are re-fetched through the authenticated API before sensitive state changes.
4. Audit artifact access requires an auditor role, an access reason, and an immutable event.
5. Deletion destroys object artifacts and the per-case data key, preserving only non-identifying proof.
