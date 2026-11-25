OrangeCrab first DDR byte, captured from the unchanged native Core DDR board at
ShiboSoftwareDev/core-ddr-benchmark `16b6352dc25e951192d88cb99a7cfe96abf62285`.

The request is the first successful `routeLocalSignalDogbones` call made by
BusLanesPipelineSolver main `2718df9b52937392f648612ca4a31d6352b585a5` for the
matching attempt. It contains all 11 original signals, all 385 physical pad
obstacles, the actual layer allocation and manufacturing rules. Coordinates
are the solver's existing rotated routing frame; no geometry or goals were edited.
The fixture shows only the 22 completed local pad-to-via approaches. It does not
claim to route the carrier paths or the full DDR board.
