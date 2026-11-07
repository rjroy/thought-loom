"""Pure helpers plus clearly separated ImageMagick tests using owned RGBA input.

No test reads source.png, build tuning, user data, a provider or a live service.
"""
import struct
import unittest
import zlib
from build import convert_png, embed_origin, output_size, run


class PureRecipeTests(unittest.TestCase):
    def test_size_preserves_owned_ratio_and_density(self):
        self.assertEqual(output_size(6, 9, 2, 2), (4, 6))
        self.assertEqual(output_size(8, 4, 6, 3), (18, 9))

    def test_invalid_size_and_inexact_ratio_fail_without_stretching(self):
        for values in [(0, 4, 2, 2), (4, -1, 2, 2), (4, 4, True, 2), (4, 4, 2, 0), (4, 3, 1, 2)]:
            with self.subTest(values=values), self.assertRaises(ValueError):
                output_size(*values)

    def test_origin_chunk_keeps_existing_bytes_and_valid_crc(self):
        prefix = b'\x89PNG\r\n\x1a\n' + b'owned-existing-chunks'
        ending = b'\0\0\0\0IEND\xaeB`\x82'
        result = embed_origin(prefix + ending, 'Owned source identity')
        self.assertEqual(result[:len(prefix)], prefix)
        self.assertEqual(result[-12:], ending)
        chunk = result[len(prefix):-12]
        size = struct.unpack('>I', chunk[:4])[0]
        self.assertEqual(chunk[4:8], b'tEXt')
        self.assertEqual(chunk[8:8 + size], b'impeccable:prompt\0Owned source identity')
        self.assertEqual(struct.unpack('>I', chunk[-4:])[0], zlib.crc32(chunk[4:-4]))
        self.assertEqual(result, embed_origin(prefix + ending, 'Owned source identity'))

    def test_non_png_or_incomplete_png_is_rejected(self):
        for value in [b'', b'not png', b'\x89PNG\r\n\x1a\nno ending']:
            with self.subTest(value=value), self.assertRaises(ValueError):
                embed_origin(value, 'Owned source identity')


class ControlledImageMagickTests(unittest.TestCase):
    """Tool integration, not pure unit tests. All pixels and sizes are owned."""

    def encode(self, pixels, width, height):
        return run('magick', '-size', f'{width}x{height}', '-depth', '8', 'RGBA:-', '-strip', 'PNG32:-', data=bytes(pixels))

    def test_identity_conversion_preserves_every_rgba_channel_including_soft_alpha(self):
        # Includes an alpha that a threshold/matte cleanup would incorrectly remove.
        pixels = bytes([20, 80, 100, 1, 40, 70, 90, 63, 250, 190, 40, 127, 10, 60, 90, 254])
        source = self.encode(pixels, 4, 1)
        output = convert_png(source, (4, 1), 'Owned fixture')
        decoded = run('magick', 'PNG:-', '-depth', '8', 'RGBA:-', data=output)
        self.assertEqual(decoded, pixels)
        self.assertIn(b'impeccable:prompt\0Owned fixture', output)
        self.assertEqual(output, convert_png(source, (4, 1), 'Owned fixture'))

    def test_downsample_keeps_soft_alpha_instead_of_flattening_or_thresholding(self):
        # Constant owned RGB isolates alpha preservation from color interpolation.
        alpha = [0, 0, 0, 0, 0, 32, 96, 160, 0, 64, 128, 192, 0, 96, 192, 240]
        pixels = bytes(channel for a in alpha for channel in (40, 80, 100, a))
        source = self.encode(pixels, 4, 4)
        output = convert_png(source, (2, 2), 'Owned downsample fixture')
        decoded = run('magick', 'PNG:-', '-depth', '8', 'RGBA:-', data=output)
        self.assertEqual(len(decoded), 16)
        values = list(decoded[3::4])
        self.assertTrue(all(0 <= a < 255 for a in values))
        self.assertTrue(any(0 < a < 255 for a in values))
        # A thresholded binary alpha image cannot pass this contract.
        self.assertGreater(len(set(values)), 1)
        self.assertEqual(output, convert_png(source, (2, 2), 'Owned downsample fixture'))


if __name__ == '__main__':
    unittest.main()
