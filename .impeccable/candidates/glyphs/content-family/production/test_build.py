"""Controlled synthetic alpha-cleanup tests; no artwork or live config fixtures."""
import unittest
from build import clean_rgba


def fixture(width, height, pixels):
    raw = bytearray(width*height*4)
    for (x,y), rgba in pixels.items():
        at=4*(y*width+x)
        raw[at:at+4]=bytes(rgba)
    return bytes(raw)


def pixel(raw, width, x, y):
    return tuple(raw[4*(y*width+x):4*(y*width+x)+4])


class AlphaCleanup(unittest.TestCase):
    def test_ring_hole_edges_shading_and_isolated_debris(self):
        pixels={(x,y):(218+x,199+y,110,254) for y in range(3,8) for x in range(3,8) if x in (3,7) or y in (3,7)}
        pixels.update({(5,2):(20,30,40,70),(5,5):(230,220,200,8),(0,0):(1,2,3,255),(10,10):(9,9,9,10)})
        raw=fixture(12,12,pixels)
        clean,report=clean_rgba(raw,12,12,4)
        self.assertEqual(report['retainedComponentCount'],1)
        self.assertEqual(pixel(clean,12,3,3),(221,202,110,255))
        self.assertEqual(pixel(clean,12,5,2),(20,30,40,70))
        self.assertEqual(pixel(clean,12,5,5),(0,0,0,0))
        self.assertEqual(pixel(clean,12,0,0),(0,0,0,0))
        self.assertEqual(pixel(clean,12,10,10),(0,0,0,0))
        self.assertEqual(pixel(clean,12,6,3)[:3],pixel(raw,12,6,3)[:3])

    def test_three_separate_components_retained(self):
        pixels={(x+offset,y):(250,240,220,255) for offset in (0,5,10) for x in (1,2) for y in (1,2)}
        clean,report=clean_rgba(fixture(15,5,pixels),15,5,4)
        self.assertEqual(report['retainedComponentAreasDescending'],[4,4,4])
        self.assertEqual(sum(a>=128 for a in clean[3::4]),12)

    def test_diagonal_connectivity_and_canvas_edges(self):
        raw=fixture(4,4,{(i,i):(11,22,33,200) for i in range(4)})
        clean,report=clean_rgba(raw,4,4,4)
        self.assertEqual(report['retainedComponentCount'],1)
        self.assertEqual(clean,raw)

    def test_repeatability_and_input_not_mutated(self):
        raw=fixture(4,4,{(1,1):(20,30,40,254),(2,1):(21,31,41,128),(1,2):(22,32,42,249)})
        before=bytes(raw)
        self.assertEqual(clean_rgba(raw,4,4,2),clean_rgba(raw,4,4,2))
        self.assertEqual(raw,before)

    def test_invalid_or_empty_input_fails_closed(self):
        with self.assertRaises(ValueError): clean_rgba(b'\0',1,1,1)
        with self.assertRaises(ValueError): clean_rgba(bytes(16),2,2,1)
        with self.assertRaises(ValueError): clean_rgba(bytes(16),2,2,0)


if __name__=='__main__':
    unittest.main()
