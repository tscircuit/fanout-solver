# T113-S3 LT8912B mixed-edge fanout fixture

This is the exact 14-connection fanout input emitted for U9 on the
96-component T113-S3 Linux board. Eleven used pads lie on the package's bottom
edge. VDD1, LPF, and XTALI lie on the right, top, and left edges respectively.

Inferring escape directions from the placeholder boundary points sends the
right- and top-edge leads downward and the left-edge lead to the right. The
bottom-edge connections route, while those three other perimeter leads cannot
escape across the package body and the fanout fails.
