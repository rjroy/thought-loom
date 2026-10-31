import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Set up weaving" };

export default function WeavingSetup() {
  return <main id="main" className="workspace setup-workspace" tabIndex={-1}>
    <h1>Set up weaving</h1>
    <p>Capturing works without an agent. To weave, an operator must connect Thoughtloom to their own OpenCode service, with an explicit registration, agent, provider and model. This page does not configure or start that service.</p>
    <ol className="setup-steps">
      <li><h2>Choose your existing service and registration</h2><p>The current integration targets OpenCode 2.2.2. Use an existing absolute registration-file path and an agent, provider and model you can actually access. The operator manages that service; Thoughtloom does not install OpenCode or launch a shared service. Selected providers may receive your source content and incur charges.</p></li>
      <li><h2>Prepare a private, isolated location</h2><p>From the repository root, run the setup command below after replacing every uppercase placeholder. Both directories must be fresh absolute paths outside this repository, not a global configuration or an existing project. The registration file must already exist.</p>
        <pre><code>{`bun run scripts/setup-native.ts \\\n  --runtime-directory /ABSOLUTE/FRESH/RUNTIME \\\n  --location-directory /ABSOLUTE/FRESH/LOCATION \\\n  --daemon-origin http://127.0.0.1:3001 \\\n  --registration-file /ABSOLUTE/EXISTING/REGISTRATION \\\n  --agent YOUR_AGENT \\\n  --provider YOUR_PROVIDER \\\n  --model YOUR_MODEL`}</code></pre>
        <p>This offline command prepares private configuration, a tool-connection file and the first-party plugin. It prints the actual native-config path. It does not activate a service or prove your provider’s compatibility. Keep these files private; do not paste registration data or credentials into the browser.</p></li>
      <li><h2>Run the matching service, then Thoughtloom</h2><p>Independently start and manage your OpenCode service for that exact prepared location and registration. Then stop any existing Thoughtloom launcher and use the actual path printed by setup:</p>
        <pre><code>{`THOUGHTLOOM_NATIVE_CONFIG_FILE='/ACTUAL/RUNTIME/native.json' bun dev`}</code></pre>
        <p>Keep both Thoughtloom services on loopback. There is no authentication or remote-phone access yet. A configured but unreachable service appears as unavailable, not as a completed run.</p></li>
      <li><h2>Capture and inspect the outcome</h2><p>Save a thought. Its original is saved before an agent run starts. Check its weaving status and explore its recorded context. A successful run may record no changes. Confirmed failures may offer Retry weaving; an uncertain outcome offers Check status instead, to avoid sending the same run twice. AI readings remain tentative and your original stays unchanged.</p></li>
    </ol>
    <Link className="button secondary" href="/">Capture a thought</Link>
  </main>;
}
