import json
import os
from pathlib import Path

import nodes
import folder_paths
from typing_extensions import override
from comfy_api.latest import IO, ComfyExtension

SPLAT_EXTENSIONS = {".spz", ".ply", ".splat", ".ksplat"}


def normalize_path(path):
    return path.replace("\\", "/")


def list_splat_files():
    input_dir = os.path.join(folder_paths.get_input_directory(), "3d")
    os.makedirs(input_dir, exist_ok=True)
    base_path = Path(folder_paths.get_input_directory())
    return [
        normalize_path(str(p.relative_to(base_path)))
        for p in Path(input_dir).rglob("*")
        if p.suffix.lower() in SPLAT_EXTENSIONS
    ]


class LoadSplatViewport(IO.ComfyNode):
    @classmethod
    def define_schema(cls):
        files = list_splat_files()
        return IO.Schema(
            node_id="LoadSplatViewport",
            display_name="Load Splat & Viewport (Spark)",
            category="3d/splat",
            is_experimental=True,
            inputs=[
                IO.Combo.Input("model_file", options=["none"] + sorted(files), upload=IO.UploadType.model),
                IO.Int.Input("width", default=1024, min=1, max=4096, step=1),
                IO.Int.Input("height", default=1024, min=1, max=4096, step=1),
                IO.String.Input("viewport", default="", multiline=False),
            ],
            outputs=[
                IO.Image.Output(display_name="image"),
                IO.Mask.Output(display_name="mask"),
                IO.Load3DCamera.Output(display_name="camera_info"),
                IO.String.Output(display_name="mesh_path"),
            ],
        )

    @classmethod
    def validate_inputs(cls, model_file, **kwargs) -> bool | str:
        if not model_file or model_file == "none":
            return True
        if not folder_paths.exists_annotated_filepath(model_file):
            return f"Invalid splat file: {model_file}"
        return True

    @classmethod
    def execute(cls, model_file, width, height, viewport, **kwargs) -> IO.NodeOutput:
        if not viewport:
            raise ValueError(
                "No viewport capture. Open the node, load a splat file, and frame your view before running."
            )
        state = json.loads(viewport)
        image_name = state.get("image", "")
        camera_info = state.get("camera_info", {})

        # LoadImage returns 1 - alpha (white = background). Invert to coverage
        # (white = splat) to match RenderSplat and the other splat nodes.
        output_image, alpha_mask = nodes.LoadImage().load_image(image=image_name)
        mask = 1.0 - alpha_mask

        mesh_path = model_file if model_file and model_file != "none" else ""
        return IO.NodeOutput(output_image, mask, camera_info, mesh_path)


class SplatLoaderExtension(ComfyExtension):
    @override
    async def get_node_list(self) -> list[type[IO.ComfyNode]]:
        return [LoadSplatViewport]


async def comfy_entrypoint() -> SplatLoaderExtension:
    return SplatLoaderExtension()
