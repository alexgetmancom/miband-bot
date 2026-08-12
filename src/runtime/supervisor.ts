export type Stoppable = { stop: () => void | Promise<void> };

export class RuntimeSupervisor {
  private readonly resources = new Set<Stoppable>();
  private stopPromise: Promise<void> | undefined;

  register(resource: Stoppable): () => void {
    if (this.stopPromise) throw new Error("Cannot register a resource after shutdown has started");
    this.resources.add(resource);
    return () => this.resources.delete(resource);
  }

  async stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    const resources = [...this.resources].reverse();
    this.resources.clear();
    this.stopPromise = (async () => {
      for (const resource of resources) await resource.stop();
    })();
    return this.stopPromise;
  }
}
