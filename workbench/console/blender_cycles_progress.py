"""Emit compact Cycles phases and actual sample counts for the local runner."""
from contextlib import contextmanager
import json
import re
from time import monotonic

import bpy


class CyclesProgress:
    _sample = re.compile(r'\bSample\s+(\d+)\s*/\s*(\d+)\b')

    def __init__(self, enabled):
        self.enabled = enabled
        self.last = None
        self.last_time = 0

    def emit(self, phase, **fields):
        if not self.enabled:
            return
        value = {'phase': phase, **fields}
        if self.last == value:
            return
        now = monotonic()
        if (phase == 'sample' and self.last and self.last['phase'] == phase and
                now - self.last_time < .25 and fields['sample'] < fields['total']):
            return
        print('ARACHNE_CYCLES_PROGRESS ' + json.dumps(value, separators=(',', ':')), flush=True)
        self.last, self.last_time = value, now

    def stats(self, text, _depsgraph):
        if not isinstance(text, str):
            return
        sample = self._sample.search(text)
        if sample:
            self.emit('sample', sample=int(sample[1]), total=int(sample[2]))
        elif 'Denoising' in text:
            self.emit('denoise')
        elif 'Compositing' in text:
            self.emit('composite')

    def render_post(self, _scene, _depsgraph):
        self.emit('write')

    @contextmanager
    def collect(self):
        if not self.enabled:
            yield
            return
        handlers = [
            (bpy.app.handlers.render_stats, self.stats),
            (bpy.app.handlers.render_post, self.render_post),
        ]
        for group, handler in handlers:
            group.append(handler)
        try:
            yield
        finally:
            for group, handler in handlers:
                group.remove(handler)
