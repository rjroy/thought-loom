"""Controlled helper fixtures, not tests of mutable artwork or visual tuning."""
import base64
import importlib.util
from pathlib import Path
import unittest
import xml.etree.ElementTree as ET

spec = importlib.util.spec_from_file_location("root_splash_build", Path(__file__).with_name("build.py"))
build = importlib.util.module_from_spec(spec)
spec.loader.exec_module(build)


class ExtractionTests(unittest.TestCase):
    def scene(self, contents):
        return ET.fromstring(f'<svg xmlns="http://www.w3.org/2000/svg">{contents}</svg>')

    def test_payload_is_decoded_without_byte_changes(self):
        owned = b"RIFF\x00\x01\xffWEBP fixture: no encoder or production pixels"
        uri = base64.b64encode(owned).decode()
        scene = self.scene(f'<image id="owned" href="data:image/webp;base64,{uri}"/>')
        self.assertEqual(build.extract_webp(scene, "owned"), owned)

    def test_missing_duplicate_and_wrong_media_are_rejected(self):
        for contents in ["", '<image id="owned"/><image id="owned"/>', '<image id="owned" href="data:image/png;base64,YQ=="/>']:
            with self.subTest(contents=contents), self.assertRaises(ValueError):
                build.extract_webp(self.scene(contents), "owned")

    def test_linear_time_mapping_uses_test_owned_ranges(self):
        for value, expected in [(10, 100), (15, 300), (20, 500)]:
            self.assertEqual(build.map_time(value, 10, 20, 100, 500), expected)

    def test_nonincreasing_source_range_is_rejected(self):
        for low, high in [(2, 2), (3, 1)]:
            with self.subTest(low=low, high=high), self.assertRaises(ValueError):
                build.map_time(2, low, high, 100, 400)

    def test_identical_duplicate_mask_is_normalized_only_in_copy(self):
        owned = '<svg xmlns="http://www.w3.org/2000/svg"><image mask="url(#owned)" id="owned" mask="url(#owned)"/></svg>'
        normalized = build.normalize_scene_markup(owned)
        self.assertEqual(ET.fromstring(normalized)[0].get("mask"), "url(#owned)")
        self.assertEqual(owned.count('mask="'), 2)

    def test_conflicting_duplicate_mask_is_rejected(self):
        with self.assertRaises(ValueError):
            build.normalize_scene_markup('<image mask="one" mask="two"/>')


if __name__ == "__main__":
    unittest.main()
