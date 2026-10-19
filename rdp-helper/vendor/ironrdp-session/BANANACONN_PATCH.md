# Local patch of ironrdp-session 0.11.0

Upstream source from crates.io (MIT OR Apache-2.0, see LICENSE-MIT and
LICENSE-APACHE), with one change in `src/fast_path.rs`:

1. `fit_to_rect`: a bitmap update's width is padded (servers round it up to a
   multiple of 4 pixels), so the decoded bitmap can be larger than its
   destination rectangle while the `apply_*` functions split rows by the
   rectangle width. That skewed every row and wrote past the end of the image
   (an "index out of bounds" panic). Every bitmap, RLE and raw update now goes
   through `fit_to_rect`, which keeps only the part inside the rectangle.

Drop this patch once an upstream release contains an equivalent fix.
