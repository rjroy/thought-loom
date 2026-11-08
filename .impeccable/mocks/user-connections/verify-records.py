"""Read-only consistency check for the finalized design handoff, not app tests."""

from hashlib import sha256
from html.parser import HTMLParser
import json
from pathlib import Path
import re
import struct


ROOT = Path(__file__).resolve().parents[3]
PACKET = Path(__file__).resolve().parent
manifest = json.loads((PACKET / "manifest.json").read_text())
selected = {
    "guided-desktop": "63f05357648be89ba35915e6eae602dd5cc5f3fc8dd3832ae6c481810d283112",
    "guided-phone": "b5e46e467f3a3180b6009f180f6f4ad10256db2053c0f054c91de064317c8893",
}

assert manifest["designHandoffFinalized"] is True
assert manifest["behaviorDecisionsResolved"] is True
assert manifest["compositionApproved"] is True
assert manifest["stateBoardsApproved"] is False
assert manifest["implementationAuthorized"] is False
assert manifest["runtimeAcceptance"] is False
assert manifest["selection"]["option"] == "B"
assert manifest["selection"]["remainingUserDecisions"] == []
assert manifest["selection"]["copyCorrection"]["requiresNewApproval"] is False
assert manifest["selection"]["copyCorrection"]["layoutChangeApproved"] is False
assert manifest["implementationFollowUp"]["issue"] == "thought-loom-rry"
assert manifest["behaviorApprovals"]["draftLifecycle"]["approved"] is True
assert manifest["behaviorApprovals"]["draftLifecycle"]["userAnswer"] == "Yes"
assert manifest["behaviorApprovals"]["uncertainSave"]["approved"] is True
assert manifest["behaviorApprovals"]["uncertainSave"]["userAnswer"] == "Yes"
assert {Path(item["path"]).stem: item["sha256"] for item in manifest["selection"]["references"]} == selected
assert {item["name"]: item["packagedSha256"] for item in manifest["images"] if item["approved"]} == selected

for image in manifest["images"]:
    path = ROOT / image["path"]
    data = path.read_bytes()
    assert sha256(data).hexdigest() == image["packagedSha256"], path
    assert json.loads(Path(str(path) + ".json").read_text()) == image, path
    assert data[:8] == b"\x89PNG\r\n\x1a\n", path
    assert struct.unpack(">II", data[16:24]) == (image["dimensions"]["width"], image["dimensions"]["height"]), path
    offset, embedded = 8, None
    while offset < len(data):
        size = struct.unpack(">I", data[offset:offset + 4])[0]
        kind = data[offset + 4:offset + 8]
        value = data[offset + 8:offset + 8 + size]
        offset += size + 12
        if kind == b"tEXt" and value.startswith(b"impeccable:prompt\0"):
            embedded = value.split(b"\0", 1)[1].decode()
    assert embedded == image["prompt"] == (ROOT / image["promptFile"]).read_text(), path


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.targets, self.images = [], []

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        for key in ("href", "src"):
            if key in attrs:
                self.targets.append(attrs[key])
        if tag == "img":
            self.images.append(attrs["src"])
            assert attrs.get("alt")


html = (PACKET / "index.html").read_text()
readme = (PACKET / "README.md").read_text()
parser = Links()
parser.feed(html)
assert len(parser.images) == 8
links = parser.targets + re.findall(r'url\("([^\"]+)"\)', html) + re.findall(r"\]\(([^)]+)\)", readme)
for link in links:
    assert not re.match(r"^[a-zA-Z]+:", link), link
    assert (PACKET / link.split("#", 1)[0]).is_file(), link
for digest in selected.values():
    assert digest in readme
assert "No remaining user design decision blocks this handoff" in readme
assert "thought-loom-rry" in readme and "thought-loom-rry" in html
for source in manifest["sourceFiles"]:
    assert sha256((ROOT / source["path"]).read_bytes()).hexdigest() == source["sha256"], source["path"]
print("PASS: scoped B selection and both explicit behavior approvals; no pending design decisions")
print("PASS: 9 unchanged PNG hashes/prompts and matching sidecars; only 2 B composition references approved")
print(f"PASS: {len(links)} local link occurrences, 8 gallery images, exact selected hashes and source-file hashes")
print("Scope: design records only; no browser, production tests, installs or services")
