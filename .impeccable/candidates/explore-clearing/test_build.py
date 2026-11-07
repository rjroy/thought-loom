import unittest
import struct
import zlib
from build import embed_origin, remove_backdrop


class MatteTests(unittest.TestCase):
    def matte(self, pixels, **changes):
        args = {'backdrop': (10, 20, 30), 'inner': 4, 'outer': 20}
        args.update(changes)
        return remove_backdrop(bytes(sum((list(p) for p in pixels), [])), len(pixels), 1, **args)

    def test_backdrop_noise_is_transparent_with_zero_rgb(self):
        output, counts = self.matte([(10, 20, 30), (6, 24, 26)])
        self.assertEqual(output, bytes(8))
        self.assertEqual(counts, {'transparent': 2, 'partial': 0, 'opaque': 0})

    def test_far_foreground_retains_rgb_and_is_opaque(self):
        pixels = [(255, 210, 40), (20, 90, 140), (30, 20, 30)]
        output, counts = self.matte(pixels)
        self.assertEqual(output, bytes(sum(([r, g, b, 255] for r, g, b in pixels), [])))
        self.assertEqual(counts['opaque'], 3)

    def test_transition_is_monotonic_keeps_rgb_and_has_midpoint(self):
        pixels = [(10 + distance, 20, 30) for distance in range(4, 21)]
        output, _ = self.matte(pixels)
        alpha = list(output[3::4])
        self.assertEqual(alpha, sorted(alpha))
        self.assertEqual(alpha[0], 0)
        self.assertEqual(alpha[-1], 255)
        self.assertEqual(alpha[8], 128)
        for index, pixel in enumerate(pixels):
            if alpha[index]:
                self.assertEqual(output[index * 4:index * 4 + 3], bytes(pixel))

    def test_distance_uses_every_channel_and_both_signs(self):
        output, _ = self.matte([(10, 0, 30), (10, 20, 50), (0, 20, 30)])
        self.assertEqual(list(output[3::4])[:2], [255, 255])
        self.assertGreater(output[11], 0)

    def test_explicit_tuning_changes_algorithm_without_artwork_dependency(self):
        first, _ = self.matte([(18, 20, 30)])
        second, _ = self.matte([(18, 20, 30)], inner=8, outer=30)
        self.assertGreater(first[3], 0)
        self.assertEqual(second, bytes(4))

    def test_invalid_inputs_fail_instead_of_truncating(self):
        for rgb, width, height in [(b'', 0, 1), (b'', 1, 1), (b'abcx', 1, 1)]:
            with self.subTest(rgb=rgb, width=width, height=height), self.assertRaises(ValueError):
                remove_backdrop(rgb, width, height, backdrop=(0, 0, 0), inner=2, outer=4)
        for options in [{'inner': 5, 'outer': 5}, {'inner': -1}, {'outer': 256}, {'backdrop': (0, 0)}, {'backdrop': (0, 0, 256)}]:
            with self.subTest(options=options), self.assertRaises(ValueError):
                self.matte([(10, 20, 30)], **options)


class ProvenanceTests(unittest.TestCase):
    def test_metadata_chunk_has_exact_payload_and_crc_without_changing_existing_chunks(self):
        # Test-owned envelope; pixel decoding belongs to the real-output verifier.
        prefix = b'\x89PNG\r\n\x1a\n' + b'test-owned-existing-chunks'
        ending = b'\0\0\0\0IEND\xaeB`\x82'
        output = embed_origin(prefix + ending, 'Source: owned fixture')
        self.assertEqual(output[:len(prefix)], prefix)
        self.assertEqual(output[-12:], ending)
        added = output[len(prefix):-12]
        size = struct.unpack('>I', added[:4])[0]
        self.assertEqual(added[4:8], b'tEXt')
        self.assertEqual(added[8:8 + size], b'impeccable:prompt\0Source: owned fixture')
        self.assertEqual(struct.unpack('>I', added[-4:])[0], zlib.crc32(added[4:-4]))
        self.assertEqual(output, embed_origin(prefix + ending, 'Source: owned fixture'))

    def test_incomplete_or_non_png_is_rejected(self):
        for value in [b'', b'not-png', b'\x89PNG\r\n\x1a\nmissing-end']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                embed_origin(value, 'owned fixture')


if __name__ == '__main__':
    unittest.main()
