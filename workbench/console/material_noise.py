"""Tiled 2D normalized fBM for editable material graphs.

Based on Blender blenlib/intern/noise.cc (Blender 4.5).
SPDX-FileCopyrightText: 2009-2010 Sony Pictures Imageworks Inc., et al.
SPDX-FileCopyrightText: 2011 Blender Authors
SPDX-License-Identifier: GPL-2.0-or-later AND BSD-3-Clause

The 3-Clause BSD License
------------------------

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

* Redistributions of source code must retain the above copyright notice,
  this list of conditions and the following disclaimer.

* Redistributions in binary form must reproduce the above copyright notice,
  this list of conditions and the following disclaimer in the documentation
  and/or other materials provided with the distribution.

* Neither the name of the copyright holder nor the names of its contributors may be
  used to endorse or promote products derived from this software without
  specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE
ARE DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT OWNER OR CONTRIBUTORS BE
LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR
CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF
SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS
INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN
CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE)
ARISING IN ANY WAY OUT OF THE USE OF THIS SOFTWARE, EVEN IF ADVISED OF THE
POSSIBILITY OF SUCH DAMAGE.
"""
import numpy as np


def _rotate(word, bits):
    return (word << bits) | (word >> (32-bits))


def _gradient(ix, iy, x, y):
    # Jenkins lookup3 finalizer for a two-word lattice coordinate, with
    # unsigned 32-bit wraparound at every subtraction.
    seed = np.uint32(0xdeadbeef + 21)
    a, b, c = seed + ix, seed + iy, seed
    c = (c ^ b) - _rotate(b,14)
    a = (a ^ c) - _rotate(c,11)
    b = (b ^ a) - _rotate(a,25)
    c = (c ^ b) - _rotate(b,16)
    a = (a ^ c) - _rotate(c,4)
    b = (b ^ a) - _rotate(a,14)
    h = ((c ^ b) - _rotate(b,24)) & 7
    u = np.where(h<4,x,y)
    v = np.where(h<4,y,x)*2
    return np.where(h&1,-u,u) + np.where(h&2,-v,v)


def _perlin(coords):
    wrapped = np.fmod(coords,100000) + (np.abs(coords)>=1000000)*np.float32(.5)
    lattice = np.floor(wrapped)
    x,y = (wrapped-lattice).T
    ix,iy = lattice.astype(np.int32).astype(np.uint32).T
    fx = x*x*x*(x*(x*6-15)+10)
    fy = y*y*y*(y*(y*6-15)+10)
    lower = (1-fx)*_gradient(ix,iy,x,y) + fx*_gradient(ix+1,iy,x-1,y)
    upper = (1-fx)*_gradient(ix,iy+1,x,y-1) + fx*_gradient(ix+1,iy+1,x-1,y-1)
    return ((1-fy)*lower + fy*upper)*np.float32(.6616)


def uv_noise(uv, scale, detail, roughness):
    coords = np.asarray(uv,dtype=np.float32)*np.asarray(scale,dtype=np.float32).reshape(-1,1)
    total = _perlin(coords)
    weight,amplitude = 1.,1.
    if roughness:
        for _ in range(int(detail)):
            coords *= 2
            amplitude *= roughness
            total += _perlin(coords)*amplitude
            weight += amplitude
    value = .5 + total*(.5/weight)
    fraction = detail-int(detail)
    if fraction and roughness:
        amplitude *= roughness
        high = .5 + (total+_perlin(coords*2)*amplitude)*(.5/(weight+amplitude))
        value += fraction*(high-value)
    return value
