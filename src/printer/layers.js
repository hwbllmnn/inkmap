import TileLayer from 'ol/layer/Tile';
import WMTS from 'ol/source/WMTS';
import XYZ from 'ol/source/XYZ';
import ImageWMS from 'ol/source/ImageWMS';
import TileWMS from 'ol/source/TileWMS';
import WFS from 'ol/format/WFS';
import GeoJSON from 'ol/format/GeoJSON';
import VectorSource from 'ol/source/Vector';
import ImageLayer from 'ol/layer/Image';
import VectorLayer from 'ol/layer/Vector';
import { bbox } from 'ol/loadingstrategy';
import { createCanvasContext2D } from 'ol/dom';
import { BehaviorSubject, interval, merge, Subject } from 'rxjs';
import {
  filter,
  map,
  startWith,
  take,
  takeWhile,
  tap,
  throttleTime,
} from 'rxjs/operators';
import { isWorker } from '../worker/utils';
import WMTSTileGrid from 'ol/tilegrid/WMTS';
import { extentFromProjection } from 'ol/tilegrid';
import { setFrameState, useContainer, generateGetFeatureUrl } from './utils';
import OpenLayersParser from 'geostyler-openlayers-parser';

const update$ = interval(500);
export const cancel$ = new Subject();

/**
 * @typedef {Array} LayerPrintStatus
 * @property {number} 0 Progress, from 0 to 1, or -1 when canceled.
 * @property {HTMLCanvasElement|OffscreenCanvas|null} 1 Canvas on which the layer is printed, or null if progress < 1.
 * @property {string} 2 URL which caused an error.
 */

/**
 * Returns an observable emitting the printing status for this layer
 * The observable will emit a final value, with the finished canvas
 * if not canceled, and complete.
 * @param {import('../main/index').Layer} layerSpec
 * @param {FrameState} rootFrameState
 * @return {Observable<LayerPrintStatus>}
 */
export function createLayer(jobId, layerSpec, rootFrameState) {
  switch (layerSpec.type) {
    case 'XYZ':
      return createLayerXYZ(jobId, layerSpec, rootFrameState);
    case 'WMS':
      return createLayerWMS(jobId, layerSpec, rootFrameState);
    case 'WMTS':
      return createLayerWMTS(jobId, layerSpec, rootFrameState);
    case 'WFS':
      return createLayerWFS(jobId, layerSpec, rootFrameState);
  }
}

/**
 * @param {number} jobId
 * @param {import('ol/source/Tile').default} source
 * @param {FrameState} rootFrameState
 * @param {number} [opacity=1]
 * @return {Observable<LayerPrintStatus>}
 */
function createTiledLayer(jobId, source, rootFrameState, opacity) {
  const width = rootFrameState.size[0];
  const height = rootFrameState.size[1];
  const context = createCanvasContext2D(width, height);
  context.canvas.style = {};
  let frameState;
  let layer;
  let renderer;
  let tileLoadErrorUrl;

  layer = new TileLayer({
    transition: 0,
    source,
  });
  layer.getSource().setTileLoadFunction(function (tile, src) {
    const image = tile.getImage();

    if (isWorker()) {
      const tileSize = layer
        .getSource()
        .getTilePixelSize(
          0,
          rootFrameState.pixelRatio,
          rootFrameState.viewState.projection
        );
      image.hintImageSize(tileSize[0], tileSize[1]);
    }

    image.src = src;
  });

  layer.getSource().on('tileloaderror', function (e) {
    tileLoadErrorUrl = e.target.getUrls()[0];
  });

  frameState = setFrameState(rootFrameState, layer, opacity);

  renderer = layer.getRenderer();
  renderer.useContainer = useContainer.bind(renderer, context);

  // this is used to make sure that tile transitions are skipped
  // TODO: remove this once the reprojected tile transitions are fixed in OL
  let fakeTime = 0;
  const frameStateWithTime = {
    ...frameState,
    get time() {
      fakeTime += 10000;
      return fakeTime;
    },
  };

  renderer.renderFrame(frameStateWithTime, context.canvas);
  const tileCount = Object.keys(frameState.tileQueue.queuedElements_).length;

  const updatedProgress$ = update$.pipe(
    startWith(true),
    takeWhile(() => {
      frameState.tileQueue.reprioritize();
      frameState.tileQueue.loadMoreTiles(12, 4);
      return frameState.tileQueue.getTilesLoading();
    }, true),
    map(() => {
      let loadedTilesCount = Object.keys(frameState.tileQueue.queuedElements_)
        .length;

      let progress = 1 - loadedTilesCount / tileCount;

      // this is to make sure all tiles have finished loading before completing layer
      if (progress === 1 && frameState.tileQueue.getTilesLoading() > 0) {
        progress -= 0.001;
      }

      if (progress === 1) {
        renderer.renderFrame(frameStateWithTime, context.canvas);
        return [1, context.canvas, tileLoadErrorUrl];
      } else {
        return [progress, null, tileLoadErrorUrl];
      }
    }),
    throttleTime(500, undefined, { leading: true, trailing: true })
  );

  const canceledProgress$ = cancel$.pipe(
    filter((canceledJobId) => canceledJobId === jobId),
    map(() => [-1, null, undefined])
  );

  return merge(updatedProgress$, canceledProgress$).pipe(
    takeWhile(([progress]) => progress !== -1 && progress !== 1, true)
  );
}

/**
 * @param {number} jobId
 * @param {import('../main/index').XyzLayer} layerSpec
 * @param {FrameState} rootFrameState
 * @return {Observable<LayerPrintStatus>}
 */
function createLayerXYZ(jobId, layerSpec, rootFrameState) {
  return createTiledLayer(
    jobId,
    new XYZ({
      crossOrigin: 'anonymous',
      url: layerSpec.url,
      transition: 0,
    }),
    rootFrameState,
    layerSpec.opacity
  );
}

/**
 * @param {import('../main/index').WmsLayer} layerSpec
 * @return {Object.<string, string|boolean>}
 */
export function getWMSParams(layerSpec) {
  return layerSpec.tiled
    ? {
        LAYERS: layerSpec.layer,
        VERSION: layerSpec.version || '1.3.0',
        TILED: true,
      }
    : {
        LAYERS: layerSpec.layer,
        VERSION: layerSpec.version || '1.3.0',
      };
}

/**
 * @param {number} jobId
 * @param {import('../main/index').WmsLayer} layerSpec
 * @param {FrameState} rootFrameState
 * @return {Observable<LayerPrintStatus>}
 */
function createLayerWMS(jobId, layerSpec, rootFrameState) {
  if (layerSpec.tiled) {
    return createTiledLayer(
      jobId,
      new TileWMS({
        crossOrigin: 'anonymous',
        url: layerSpec.url,
        params: getWMSParams(layerSpec),
        transition: 0,
      }),
      rootFrameState,
      layerSpec.opacity
    );
  }

  const width = rootFrameState.size[0];
  const height = rootFrameState.size[1];
  const context = createCanvasContext2D(width, height);
  context.canvas.style = {};
  let frameState;
  let layer;
  let renderer;
  const progress$ = new BehaviorSubject([0, null, undefined]);

  layer = new ImageLayer({
    transition: 0,
    source: new ImageWMS({
      crossOrigin: 'anonymous',
      url: layerSpec.url,
      params: getWMSParams(layerSpec),
      ratio: 1,
    }),
  });
  layer.getSource().setImageLoadFunction(function (layerImage, src) {
    const image = layerImage.getImage();
    if (isWorker()) {
      image.hintImageSize(width, height);
    }

    const blankSrc =
      'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
    cancel$
      .pipe(
        filter((canceledJobId) => canceledJobId === jobId),
        take(1),
        tap(() => {
          progress$.next([-1, null, undefined]);
          progress$.complete();
          image.src = blankSrc;
        })
      )
      .subscribe();

    image.src = src;
  });

  frameState = setFrameState(rootFrameState, layer, layerSpec.opacity);

  renderer = layer.getRenderer();
  renderer.useContainer = useContainer.bind(renderer, context);

  layer.getSource().once('imageloaderror', function (e) {
    const imageLoadErrorUrl = e.target.getUrl();
    progress$.next([1, context.canvas, imageLoadErrorUrl]);
    progress$.complete();
  });
  layer.getSource().once('imageloadend', () => {
    renderer.prepareFrame({ ...frameState, time: Date.now() });
    renderer.renderFrame({ ...frameState, time: Date.now() }, context.canvas);
    progress$.next([1, context.canvas, undefined]);
    progress$.complete();
  });
  renderer.prepareFrame({ ...frameState, time: Date.now() });

  return progress$;
}

/**
 * @param {number} jobId
 * @param {import('../main/index').WmtsLayer} layerSpec
 * @param {FrameState} rootFrameState
 * @return {Observable<LayerPrintStatus>}
 */
function createLayerWMTS(jobId, layerSpec, rootFrameState) {
  let { tileGrid, projection } = layerSpec;
  let { resolutions, extent, matrixIds } = tileGrid;
  extent = extent || extentFromProjection(projection);
  matrixIds = matrixIds || [...Array(resolutions.length).keys()];

  tileGrid = new WMTSTileGrid({
    ...tileGrid,
    extent,
    matrixIds,
  });

  return createTiledLayer(
    jobId,
    new WMTS({
      ...layerSpec,
      tileGrid,
      projection,
      transition: 0,
      crossOrigin: 'anonymous',
    }),
    rootFrameState,
    layerSpec.opacity
  );
}

/**
 * @param {number} jobId
 * @param {import('../main/index').WfsLayer} layerSpec
 * @param {FrameState} rootFrameState
 * @return {Observable<LayerPrintStatus>}
 */
function createLayerWFS(jobId, layerSpec, rootFrameState) {
  const width = rootFrameState.size[0];
  const height = rootFrameState.size[1];
  const context = createCanvasContext2D(width, height);
  context.canvas.style = {};
  let frameState;
  let renderer;
  const version = layerSpec.version || '1.1.0';
  const format =
    layerSpec.format === 'geojson' ? new GeoJSON() : new WFS({ version });
  const progress$ = new BehaviorSubject([0, null]);

  let vectorSource = new VectorSource({
    format,
    loader: function (extent, resolution, projection) {
      const projCode = projection.getCode();
      const requestUrl = generateGetFeatureUrl(
        layerSpec.url,
        version,
        layerSpec.layer,
        layerSpec.format,
        projCode,
        extent
      );
      const xhr = new XMLHttpRequest();
      xhr.open('GET', requestUrl);
      let onError = function () {
        vectorSource.removeLoadedExtent(extent);
        progress$.next([1, context.canvas, layerSpec.url]);
        progress$.complete();
      };
      xhr.onerror = onError;
      xhr.onload = function () {
        if (xhr.status == 200) {
          vectorSource.addFeatures(
            vectorSource.getFormat().readFeatures(xhr.responseText)
          );
          if (vectorSource.getFeatures().length !== 0) {
            renderer.prepareFrame({ ...frameState, time: Date.now() });
            renderer.renderFrame(
              { ...frameState, time: Date.now() },
              context.canvas
            );
          }
          progress$.next([1, context.canvas]);
          progress$.complete();
        } else {
          onError();
        }
      };

      cancel$
        .pipe(
          filter((canceledJobId) => canceledJobId === jobId),
          take(1),
          tap(() => {
            progress$.next([-1, null]);
            progress$.complete();
            xhr.abort();
          })
        )
        .subscribe();

      xhr.send();
    },
    strategy: bbox,
  });

  let layer = new VectorLayer({
    source: vectorSource,
  });

  if (layerSpec.style) {
    const parser = new OpenLayersParser();
    parser
      .writeStyle(layerSpec.style)
      .then((olStyle) => layer.setStyle(olStyle))
      .catch((error) => console.log(error));
  }

  frameState = setFrameState(rootFrameState, layer);
  renderer = layer.getRenderer();
  renderer.useContainer = useContainer.bind(renderer, context);

  renderer.prepareFrame({ ...frameState, time: Date.now() });

  return progress$;
}
