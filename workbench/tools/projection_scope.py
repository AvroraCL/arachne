"""Shared, conservative world-space projection protection rules."""


def is_protected(name, points, excluded_names, regions):
    if name in excluded_names:
        return True
    for region in regions:
        if region.get('objects') and name not in region['objects']:
            continue
        # Deliberately identical to the transfer stage's triangle AABB policy.
        if all(max(p[k] for p in points) >= region['min'][k] and
               min(p[k] for p in points) <= region['max'][k] for k in range(3)):
            return True
    return False
