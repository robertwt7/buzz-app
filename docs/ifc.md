# Information-flow control

> **Status:** these crates implement the broker design, an alternative considered. Buzz follows the channel-based design in block/buzz's [`VISION_INFORMATION_FLOW.md`](https://github.com/block/buzz/blob/main/VISION_INFORMATION_FLOW.md) instead.

The policy library is ported from `block/buzz` at
`c94c7128dd6c5cf12486cad0ed767b4ac21ca56a` (PR #8226).

- `ifc-core` supplies reader-set labels, their flow ordering, and accumulated
  flow state. It has no Buzz dependencies.
- `buzz-ifc` derives execution domains from verified Buzz facts and labels
  resources from their own conversation. Domains compare structurally; event
  IDs, topics, and membership ordering do not affect equality.
- `IfcSession` preserves a domain's flow state and checks reads, non-publishing
  calls, and publications. `AuthorizedPublication` owns the exact checked bytes.

These APIs perform no I/O. A broker must verify signatures, establish the
community and current membership, and retain the IFC session for as long as the
corresponding agent state survives. Domain equality is not a temporal epoch.
Unknown inputs remain recorded and block publication.

The port retains the source policy, public APIs, doctests, and regression tests.
Its only adaptations are local Cargo dependencies, the app's Nostr version,
and a local UUID-backed `CommunityId`, avoiding the relay's `buzz-core` crate.
The [design paper](practical-information-flow-for-buzz-agents.md) describes the
model and its assumptions. Adding these crates alone does not mediate Agents2.
