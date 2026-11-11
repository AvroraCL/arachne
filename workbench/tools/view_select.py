"""Deterministic, conservative face-view selection using same-object adjacency."""
import numpy as np

def choose(scores, candidates, neighbors, mode, margin):
    choice=np.where(candidates.any(axis=1),scores.argmax(axis=1),-1).astype(np.int16)
    if mode != 'adjacency': return choice
    # Sequential strict-improvement updates avoid the two-face oscillation that
    # can arise with simultaneous voting. Never replace with a less-visible view
    # whose incidence score differs from the best by more than margin.
    nviews=scores.shape[1]
    for _ in range(2):
        for i in range(len(choice)):
            current=int(choice[i])
            if current<0 or not neighbors[i]: continue
            votes=np.bincount([int(choice[j]) for j in neighbors[i] if choice[j]>=0],minlength=nviews)
            eligible=[v for v in range(nviews) if candidates[i,v] and scores[i,v]>=scores[i].max()-margin]
            best=min(eligible,key=lambda v:(-votes[v],-scores[i,v],v))
            if votes[best]>votes[current]: choice[i]=best
    return choice
