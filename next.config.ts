import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /**
   * `next dev` otherwise appends a block of its own guidance to CLAUDE.md on
   * every run. That file is this repository's instructions, written and kept by
   * hand, and a build tool editing it turns every dev session into an
   * uncommitted change nobody made.
   */
  agentRules: false,
};

export default nextConfig;
