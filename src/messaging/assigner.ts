import { Photon, ApiError } from "@photon-ai/api";

/** Puts a person on Photon's shared iMessage line so they can text the agent (and be texted back). */
export interface LineAssigner {
  assign(handle: string, firstName: string): Promise<{ number: string; alreadyAssigned: boolean }>;
}

export class ConsoleAssigner implements LineAssigner {
  constructor(private number: string) {}
  async assign() { return { number: this.number, alreadyAssigned: false }; }
}

export class PhotonAssigner implements LineAssigner {
  private photon: Photon;
  constructor(apiKey: string, private projectId: string, private fallbackNumber: string) {
    this.photon = new Photon({ headers: { Authorization: `Bearer ${apiKey}` } });
  }
  private async findActive(handle: string) {
    const list = await this.photon.projects.platforms.imessage.assignments.list({ path: { id: this.projectId } });
    return list.assignments.find((x) => x.handle === handle);
  }
  async assign(handle: string, firstName: string) {
    // Active assignment already? Use it (a cheap read; this runs on page loads).
    const existing = await this.findActive(handle);
    if (existing) return { number: existing.assignedPhoneNumber, alreadyAssigned: true };
    try {
      // Fresh idempotency key per attempt: reusing an old key after a release could replay the released assignment.
      const a = await this.photon.projects.platforms.imessage.assignments.create({
        path: { id: this.projectId },
        headers: { idempotencyKey: `letsgrow-assign-${handle}-${Date.now()}` },
        body: { handle, firstName },
      });
      return { number: a.assignedPhoneNumber, alreadyAssigned: false };
    } catch (err) {
      // 409 ASSIGNMENT_EXISTS: raced with another request; look it up again.
      if (err instanceof ApiError && err.status === 409) {
        const hit = await this.findActive(handle).catch(() => undefined);
        return { number: hit?.assignedPhoneNumber ?? this.fallbackNumber, alreadyAssigned: true };
      }
      throw err;
    }
  }
}
