# Splat Loader

Splat Loader is a custom node for [ComfyUI](https://github.com/comfyanonymous/ComfyUI) that loads Gaussian splat files, lets you frame a shot inside the node with a real splat viewport, and outputs exactly that view as an image when you run the workflow. It is heavily inspired by the BETA "Load 3D & Animation" node, but built for Gaussian splats instead of meshes.

The viewport is powered by [Spark](https://sparkjs.dev/), so splats actually render the way they should while you pick your angle.

![Screenshot preview](./screenshot.png)

## Goal of this node
ComfyUI already ships splat nodes, but they only load `.ply` and none of them let you choose a camera angle from inside the node the way the BETA "Load 3D" node does for meshes. The core 3D viewer also does not render Gaussian splats correctly, so framing a shot is guesswork.

Splat Loader fixes both problems: you load a splat, orbit around it in a proper viewport, and what you see is what you get as the image output.

> Note: the image output is captured from the viewport itself, so the result matches your framing exactly. The capture resolution comes from the `width` and `height` inputs.

Supported formats: `.spz`, `.ply`, `.splat`, `.ksplat`.

## How to install
### Via ComfyUI Manager (recommended)
Search for **Splat Loader** in [ComfyUI Manager](https://github.com/Comfy-Org/ComfyUI-Manager) and install it. The prebuilt viewport is bundled, so you do not need Node.js or any build step. Restart ComfyUI when prompted and you are done.

### Manual installation
The viewport is a small web app that has to be built once, so you need [Node.js](https://nodejs.org/). A standard ComfyUI installation does not include it, so install it first if you do not have it.

> Note: Node.js is only needed to build the viewport. ComfyUI itself does not use it.

Clone this repository into your ComfyUI `custom_nodes` directory:
```bash
cd ComfyUI/custom_nodes
git clone https://github.com/brayevalerien/comfyui-splat-loader
```

Then cd into it, install the dependencies and build the viewport bundle:
```bash
cd comfyui-splat-loader
npm install
npm run build
```
This generates `web/viewport.js`, which the frontend loads.

Finally, restart the ComfyUI server and refresh your browser. The node is ready to use.

> Note: if you edit the viewport code later, rerun `npm run build` (or use `npm run watch` to rebuild on every change). A browser hard refresh is then enough, no server restart needed.

## How to use
Add the node by searching for **Load Splat & Viewport (Spark)** (category `3d/splat`).

1. Load a splat file, either with the **Load file** button (opens your filesystem and uploads it into `ComfyUI/input/3d`) or from the `model_file` dropdown if it is already there (this dropdown lists the splat files in your ComfyUI input folder).
2. Start by setting the viewport resolution, it will also be the output resolution
3. Adjust the other camera settings (FOV, camera type) and use the viewport to navigate the scene
4. Adjust the splat scale so they fill the view without overlapping too much
5. If you want a turntable render (have multiple images distributed in an orbit around your viewpoint), set a number of frames higher than 1. Setting a negative number of frames goes the other way around.

There are several navigation related buttons in the viewport, including one for flipping the gaussian splats upside down since `.spz` files tend to be y-down.

There also is a bookmark function. Hit the bookmark icon to open to save views and restore them later. The bookmark contains the camera postion and orientation but also all the camera related settings (e.g. type and FOV). You can delete or rename views by hovering them.

Outputs:
- `image`: the framed view (a batch when `frames` > 1), with a black background
- `mask`: the splat coverage (white where the splat is), matching the other splat nodes
- `camera_info`: the camera used, compatible with the other 3D and splat nodes
- `mesh_path`: the input-relative path of the loaded file

## Acknowledgements
- [Spark](https://sparkjs.dev/) for the Gaussian splat renderer
- [three.js](https://threejs.org/) for the viewport
- The ComfyUI "Load 3D & Animation" node for the overall idea
