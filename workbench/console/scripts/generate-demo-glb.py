"""Write the original Arachne sample with glTF 2.0 buffers and authored UVs."""
import json
from pathlib import Path
import struct
import sys


def box_vertices(minimum, maximum):
    x, y, z = minimum
    X, Y, Z = maximum
    return [(x, y, z), (X, y, z), (X, Y, z), (x, Y, z),
            (x, y, Z), (X, y, Z), (X, Y, Z), (x, Y, Z)]


def build():
    gltf = {
        "asset": {"version": "2.0", "generator": "Arachne"},
        "scene": 0, "scenes": [{"nodes": [0, 1]}],
        "nodes": [{"name": "Housing", "mesh": 0}, {"name": "Cover", "mesh": 1}],
        "materials": [
            {"name": "Housing", "pbrMetallicRoughness": {
                "baseColorFactor": [0.061, 0.078, 0.112, 1], "metallicFactor": 0, "roughnessFactor": 0.46}},
            {"name": "Cover", "pbrMetallicRoughness": {
                "baseColorFactor": [0.18, 0.20, 0.23, 1], "metallicFactor": 0.2, "roughnessFactor": 0.32}},
        ],
        "meshes": [], "bufferViews": [], "accessors": [],
    }
    buffer = bytearray()

    def accessor(values, width, component, bounds=False):
        while len(buffer) % 4:
            buffer.append(0)
        offset = len(buffer)
        flat = [number for item in values for number in item]
        fmt = "f" if component == 5126 else "H"
        buffer.extend(struct.pack(f"<{len(flat)}{fmt}", *flat))
        views, accessors = gltf["bufferViews"], gltf["accessors"]
        views.append({"buffer": 0, "byteOffset": offset, "byteLength": len(buffer) - offset})
        record = {"bufferView": len(views) - 1, "componentType": component, "count": len(values),
                  "type": {1: "SCALAR", 2: "VEC2", 3: "VEC3"}[width]}
        if bounds:
            record["min"] = [min(axis) for axis in zip(*values)]
            record["max"] = [max(axis) for axis in zip(*values)]
        accessors.append(record)
        return len(accessors) - 1

    def box(minimum, maximum, material, with_uv):
        vertices = box_vertices(minimum, maximum)
        faces = [(0, 3, 2, 1), (4, 5, 6, 7), (0, 1, 5, 4),
                 (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]
        positions, uv, indices = [], [], []
        for face_index, face in enumerate(faces):
            start = len(positions)
            # Rotate the authored Z-up coordinates into glTF Y-up.
            positions.extend((x, z, -y) for x, y, z in (vertices[i] for i in face))
            indices.extend((start + index,) for index in (0, 1, 2, 0, 2, 3))
            u, v = (face_index % 4) * 0.25, (face_index // 4) * 0.25
            uv.extend((u + du, v + dv) for du, dv in [(0.02, 0.02), (0.23, 0.02), (0.23, 0.23), (0.02, 0.23)])
        attributes = {"POSITION": accessor(positions, 3, 5126, bounds=True)}
        if with_uv:
            attributes["TEXCOORD_0"] = accessor(uv, 2, 5126)
        gltf["meshes"].append({"primitives": [{"attributes": attributes,
                                               "indices": accessor(indices, 1, 5123), "material": material}]})

    box((-2, -1.3, -0.5), (2, 1.3, 0.35), 0, True)
    box((0.85, 0.5, 0.35), (1.55, 1.05, 0.7), 1, False)
    gltf["buffers"] = [{"byteLength": len(buffer)}]
    metadata = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
    metadata += b" " * ((-len(metadata)) % 4)
    buffer.extend(b"\0" * ((-len(buffer)) % 4))
    return (struct.pack("<4sII", b"glTF", 2, 28 + len(metadata) + len(buffer))
            + struct.pack("<I4s", len(metadata), b"JSON") + metadata
            + struct.pack("<I4s", len(buffer), b"BIN\0") + buffer)


if __name__ == "__main__":
    Path(sys.argv[1]).write_bytes(build())
