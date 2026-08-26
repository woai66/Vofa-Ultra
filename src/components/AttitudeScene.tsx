import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  AmbientLight,
  ArrowHelper,
  BoxGeometry,
  Color,
  ConeGeometry,
  CylinderGeometry,
  DirectionalLight,
  Fog,
  GridHelper,
  Group,
  Mesh,
  MeshStandardMaterial,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Scene,
  SRGBColorSpace,
  Texture,
  Vector3,
  WebGLRenderer,
  type Material,
  type Object3D,
} from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import type { ThemeMode } from "../App";
import type { AttitudeCoordinateFrame, AttitudeQuaternion } from "../types/attitude";

interface AttitudeSceneProps {
  orientation: AttitudeQuaternion;
  coordinateFrame: AttitudeCoordinateFrame;
  theme: ThemeMode;
  resetToken: number;
  onRendererError(message: string | null): void;
}

interface SceneRuntime {
  resetCamera(): void;
}

const CAMERA_POSITION = new Vector3(6.2, 4.4, 6.2);
const CAMERA_TARGET = new Vector3(0, 0, 0);

export function AttitudeScene({
  orientation,
  coordinateFrame,
  theme,
  resetToken,
  onRendererError,
}: AttitudeSceneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orientationRef = useRef(orientation);
  const runtimeRef = useRef<SceneRuntime | null>(null);
  const [rendererStatus, setRendererStatus] = useState<
    "loading" | "ready" | "lost" | "error"
  >("loading");
  orientationRef.current = orientation;

  useEffect(() => {
    runtimeRef.current?.resetCamera();
  }, [resetToken]);

  useLayoutEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) {
      return undefined;
    }

    setRendererStatus("loading");
    let renderer: WebGLRenderer;
    try {
      renderer = new WebGLRenderer({
        canvas,
        antialias: true,
        alpha: false,
        powerPreference: "high-performance",
      });
    } catch {
      setRendererStatus("error");
      onRendererError("当前环境无法创建 WebGL 姿态视图");
      return undefined;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.outputColorSpace = SRGBColorSpace;

    const palette = scenePalette(theme);
    const scene = new Scene();
    scene.background = new Color(palette.background);
    scene.fog = new Fog(palette.background, 10, 22);

    const camera = new PerspectiveCamera(38, 1, 0.1, 100);
    camera.position.copy(CAMERA_POSITION);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.enablePan = false;
    controls.minDistance = 4;
    controls.maxDistance = 14;
    controls.minPolarAngle = 0.18;
    controls.maxPolarAngle = Math.PI * 0.49;
    controls.target.copy(CAMERA_TARGET);
    controls.update();

    scene.add(new AmbientLight(palette.ambient, theme === "light" ? 1.7 : 1.25));
    const keyLight = new DirectionalLight(palette.keyLight, theme === "light" ? 3.2 : 4.2);
    keyLight.position.set(5, 8, 4);
    scene.add(keyLight);
    const fillLight = new DirectionalLight(palette.fillLight, 1.8);
    fillLight.position.set(-5, 2, -5);
    scene.add(fillLight);

    const floor = new Mesh(
      new PlaneGeometry(24, 24),
      new MeshStandardMaterial({ color: palette.floor, roughness: 0.96, metalness: 0 }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.26;
    scene.add(floor);

    const grid = new GridHelper(12, 12, palette.gridStrong, palette.grid);
    grid.position.y = -1.25;
    scene.add(grid);

    const axisOrigin = new Vector3(0, -1.22, 0);
    scene.add(new ArrowHelper(new Vector3(1, 0, 0), axisOrigin, 2.2, 0xe25764, 0.18, 0.1));
    scene.add(new ArrowHelper(new Vector3(0, 1, 0), axisOrigin, 2.2, 0x46c98b, 0.18, 0.1));
    scene.add(new ArrowHelper(new Vector3(0, 0, -1), axisOrigin, 2.2, 0x55aee8, 0.18, 0.1));

    const device = createDeviceModel(theme);
    const initialOrientation = toThreeQuaternion(orientationRef.current);
    device.quaternion.copy(initialOrientation);
    scene.add(device);

    const resetCamera = () => {
      camera.position.copy(CAMERA_POSITION);
      controls.target.copy(CAMERA_TARGET);
      controls.update();
    };
    runtimeRef.current = { resetCamera };

    const resize = () => {
      const width = Math.max(1, Math.floor(container.clientWidth));
      const height = Math.max(1, Math.floor(container.clientHeight));
      renderer.setSize(width, height, false);
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    resize();

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    const reducedMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    const currentOrientation = initialOrientation.clone();
    const targetOrientation = initialOrientation.clone();
    let animationFrame: number | null = null;
    let contextLost = false;
    let disposed = false;
    let lastFrameAt = performance.now();

    const stopRendering = () => {
      if (animationFrame === null) {
        return;
      }
      cancelAnimationFrame(animationFrame);
      animationFrame = null;
    };

    const renderFrame = (now: number) => {
      animationFrame = null;
      if (disposed || contextLost) {
        return;
      }
      const elapsedSeconds = Math.min(0.1, Math.max(0, (now - lastFrameAt) / 1_000));
      lastFrameAt = now;
      targetOrientation.copy(toThreeQuaternion(orientationRef.current));
      const blend = reducedMotion ? 1 : 1 - Math.exp(-12 * elapsedSeconds);
      currentOrientation.slerp(targetOrientation, blend);
      device.quaternion.copy(currentOrientation);
      controls.update();
      renderer.render(scene, camera);
      if (!disposed && !contextLost) {
        animationFrame = requestAnimationFrame(renderFrame);
      }
    };

    const startRendering = () => {
      if (disposed || contextLost || animationFrame !== null) {
        return;
      }
      lastFrameAt = performance.now();
      animationFrame = requestAnimationFrame(renderFrame);
    };

    const handleContextLost = (event: Event) => {
      event.preventDefault();
      if (disposed || contextLost) {
        return;
      }
      contextLost = true;
      stopRendering();
      setRendererStatus("lost");
      onRendererError("显卡上下文已丢失，正在等待自动恢复");
    };

    const handleContextRestored = () => {
      if (disposed || !contextLost) {
        return;
      }
      contextLost = false;
      resize();
      if (contextLost) {
        return;
      }
      onRendererError(null);
      setRendererStatus("ready");
      startRendering();
    };

    canvas.addEventListener("webglcontextlost", handleContextLost);
    canvas.addEventListener("webglcontextrestored", handleContextRestored);
    onRendererError(null);
    setRendererStatus("ready");
    startRendering();

    return () => {
      disposed = true;
      canvas.removeEventListener("webglcontextlost", handleContextLost);
      canvas.removeEventListener("webglcontextrestored", handleContextRestored);
      stopRendering();
      resizeObserver.disconnect();
      controls.dispose();
      runtimeRef.current = null;
      disposeScene(scene);
      renderer.renderLists.dispose();
      renderer.dispose();
    };
  }, [onRendererError, theme]);

  return (
    <div
      ref={containerRef}
      className="attitude-scene"
      data-coordinate-frame={coordinateFrame}
      data-renderer={rendererStatus}
      role="img"
      aria-label="三维姿态视图"
    >
      <canvas ref={canvasRef} aria-hidden="true" />
    </div>
  );
}

function createDeviceModel(theme: ThemeMode): Group {
  const group = new Group();
  const bodyMaterial = new MeshStandardMaterial({
    color: theme === "light" ? 0x3a4540 : 0x222b27,
    roughness: 0.62,
    metalness: 0.22,
  });
  const plateMaterial = new MeshStandardMaterial({
    color: theme === "light" ? 0x147452 : 0x1a8a60,
    roughness: 0.48,
    metalness: 0.12,
  });
  const darkMaterial = new MeshStandardMaterial({
    color: theme === "light" ? 0x202824 : 0x090d0b,
    roughness: 0.5,
    metalness: 0.32,
  });
  const frontMaterial = new MeshStandardMaterial({
    color: 0x55bde8,
    roughness: 0.36,
    metalness: 0.18,
    emissive: 0x0b2430,
  });
  const rearMaterial = new MeshStandardMaterial({
    color: 0xf0b35a,
    roughness: 0.4,
    metalness: 0.16,
  });

  const body = new Mesh(new BoxGeometry(2.8, 1.8, 0.34), bodyMaterial);
  group.add(body);
  const topPlate = new Mesh(new BoxGeometry(2.25, 1.35, 0.12), plateMaterial);
  topPlate.position.z = 0.23;
  group.add(topPlate);
  const controller = new Mesh(new BoxGeometry(0.72, 0.72, 0.14), darkMaterial);
  controller.position.z = 0.37;
  group.add(controller);

  const front = new Mesh(new ConeGeometry(0.34, 0.72, 3), frontMaterial);
  front.rotation.z = -Math.PI / 2;
  front.position.set(1.72, 0, 0.02);
  group.add(front);
  const rearBar = new Mesh(new BoxGeometry(0.18, 1.2, 0.12), rearMaterial);
  rearBar.position.set(-1.17, 0, 0.38);
  group.add(rearBar);

  const screwMaterial = new MeshStandardMaterial({
    color: theme === "light" ? 0x9aa49e : 0x77837c,
    roughness: 0.28,
    metalness: 0.72,
  });
  for (const x of [-1.05, 1.05]) {
    for (const y of [-0.64, 0.64]) {
      const screw = new Mesh(new CylinderGeometry(0.075, 0.075, 0.08, 12), screwMaterial);
      screw.rotation.x = Math.PI / 2;
      screw.position.set(x, y, 0.34);
      group.add(screw);
    }
  }

  group.add(new ArrowHelper(new Vector3(1, 0, 0), new Vector3(), 1.95, 0xe25764, 0.22, 0.12));
  group.add(new ArrowHelper(new Vector3(0, 1, 0), new Vector3(), 1.35, 0x46c98b, 0.2, 0.11));
  group.add(new ArrowHelper(new Vector3(0, 0, 1), new Vector3(), 1.2, 0x55aee8, 0.2, 0.11));
  return group;
}

function scenePalette(theme: ThemeMode) {
  return theme === "light"
    ? {
        background: 0xf4f7f5,
        floor: 0xe9eeeb,
        grid: 0xcbd5cf,
        gridStrong: 0x9aaba1,
        ambient: 0xffffff,
        keyLight: 0xffffff,
        fillLight: 0xb8d6ca,
      }
    : {
        background: 0x111513,
        floor: 0x151a17,
        grid: 0x2b342f,
        gridStrong: 0x526159,
        ambient: 0xc6ddd2,
        keyLight: 0xffffff,
        fillLight: 0x4b8a70,
      };
}

function toThreeQuaternion(value: AttitudeQuaternion): Quaternion {
  return new Quaternion(value.x, value.y, value.z, value.w).normalize();
}

function disposeScene(scene: Scene): void {
  scene.traverse((object: Object3D) => {
    const mesh = object as Mesh;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    materials.filter((material): material is Material => Boolean(material)).forEach((material) => {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) {
          value.dispose();
        }
      }
      material.dispose();
    });
  });
}
