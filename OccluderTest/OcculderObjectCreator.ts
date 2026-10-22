import { _decorator, Camera, Component, Material, MeshRenderer, Node, PolygonCollider2D, UITransform, utils, Vec2, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

/** Builds a 3D occluder from the 2D foreground silhouette. */
@ccclass('OcculderObjectCreator')
export class OcculderObjectCreator extends Component {
    @property(Node) public targetUINode: Node | null = null;
    @property(Node) public target3DCharacter: Node | null = null;
    @property(Camera) public camera2D: Camera | null = null;
    @property(Camera) public camera3D: Camera | null = null;
    @property(Material) public mat: Material | null = null;
    @property public depthOffset = 0.05;

    start(): void {
        // Wait one frame so both cameras have initialized their view/projection matrices.
        this.scheduleOnce(() => this.generateComplexMesh(), 0);
    }

    public generateComplexMesh(): void {
        const uiNode = this.targetUINode;
        const character = this.target3DCharacter;
        const camera2D = this.camera2D;
        const camera3D = this.camera3D;
        if (!uiNode || !character || !camera2D || !camera3D || !this.mat) {
            console.warn('[OcculderObjectCreator] Assign both nodes, both cameras, and a material.');
            return;
        }

        const collider = uiNode.getComponent(PolygonCollider2D);
        if (!collider || collider.points.length < 3) {
            console.warn('[OcculderObjectCreator] The 2D target needs a PolygonCollider2D with at least 3 points.');
            return;
        }

        // Calculate the wall distance along the 3D camera view axis.
        // Camera views along local -Z; transform its view direction to world space.
        const cameraForward = new Vec3(0, 0, -1);
        Vec3.transformQuat(cameraForward, cameraForward, camera3D.node.worldRotation);
        const characterPosition = character.worldPosition;
        const characterDepth = Vec3.dot(
            new Vec3(characterPosition.x - camera3D.node.worldPosition.x,
                characterPosition.y - camera3D.node.worldPosition.y,
                characterPosition.z - camera3D.node.worldPosition.z),
            cameraForward,
        );
        if (characterDepth <= 0) {
            console.warn('[OcculderObjectCreator] Character must be in front of the 3D camera.');
            return;
        }
        // Move the wall slightly toward the camera so it wins the depth test over the feet.
        const cameraDepth = Math.max(0.001, characterDepth - Math.max(0, this.depthOffset));
        // The wall is a plane parallel to the camera image plane. Intersect each
        // screen-space ray with it instead of guessing screenToWorld's depth value:
        // perspective depth is nonlinear and changes with FOV/aspect ratio.
        const planePoint = new Vec3(
            camera3D.node.worldPosition.x + cameraForward.x * cameraDepth,
            camera3D.node.worldPosition.y + cameraForward.y * cameraDepth,
            camera3D.node.worldPosition.z + cameraForward.z * cameraDepth,
        );

        const uiTransform = uiNode.getComponent(UITransform);
        if (!uiTransform) {
            console.warn('[OcculderObjectCreator] The 2D target needs a UITransform.');
            return;
        }

        const points: Vec3[] = [];
        const screen = new Vec3();
        const nearPoint = new Vec3();
        const farPoint = new Vec3();
        const world = new Vec3();
        const local = new Vec3();
        const rayDelta = new Vec3();
        for (const point of collider.points) {
            const uiWorld = uiTransform.convertToWorldSpaceAR(new Vec3(point.x, point.y, 0));
            camera2D.worldToScreen(uiWorld, screen);
            camera3D.screenToWorld(new Vec3(screen.x, screen.y, 0), nearPoint);
            camera3D.screenToWorld(new Vec3(screen.x, screen.y, 1), farPoint);
            Vec3.subtract(rayDelta, farPoint, nearPoint);
            const denominator = Vec3.dot(rayDelta, cameraForward);
            if (Math.abs(denominator) < 1e-7) {
                console.warn('[OcculderObjectCreator] Camera ray is parallel to the occluder plane.');
                return;
            }
            const toPlane = new Vec3(
                planePoint.x - nearPoint.x,
                planePoint.y - nearPoint.y,
                planePoint.z - nearPoint.z,
            );
            const rayT = Vec3.dot(toPlane, cameraForward) / denominator;
            if (rayT < 0 || rayT > 1) {
                console.warn('[OcculderObjectCreator] Occluder plane is outside the camera clipping range.');
                return;
            }
            world.set(
                nearPoint.x + rayDelta.x * rayT,
                nearPoint.y + rayDelta.y * rayT,
                nearPoint.z + rayDelta.z * rayT,
            );
            this.node.inverseTransformPoint(local, world);
            points.push(new Vec3(local.x, local.y, local.z));
        }

        const triangles = this.triangulate(points);
        if (triangles.length === 0) {
            console.warn('[OcculderObjectCreator] Could not triangulate the 2D occluder polygon.');
            return;
        }

        const positions: number[] = [];
        const normals: number[] = [];
        for (const point of points) {
            positions.push(point.x, point.y, point.z);
            // The generated wall is parallel to the camera in this scene.
            normals.push(0, 0, 1);
        }
        const indices: number[] = [];
        // Emit both face directions so the wall remains visible from either side.
        for (let i = 0; i < triangles.length; i += 3) {
            const a = triangles[i];
            const b = triangles[i + 1];
            const c = triangles[i + 2];
            indices.push(a, b, c, c, b, a);
        }

        const renderer = this.node.getComponent(MeshRenderer) || this.node.addComponent(MeshRenderer);
        // Bounds are required for the renderer to cull a large generated mesh correctly.
        renderer.mesh = utils.createMesh({ positions, normals, indices }, undefined, { calculateBounds: true });
        renderer.setMaterial(this.mat, 0);
    }

    /** Ear clipping supports concave outlines, unlike a triangle fan. */
    private triangulate(points: Vec3[]): number[] {
        const polygon = points.map((point, index) => ({ point: new Vec2(point.x, point.y), index }));
        this.removeDegenerateVertices(polygon);
        if (polygon.length < 3) {
            return [];
        }

        let area = 0;
        for (let i = 0; i < polygon.length; i++) {
            const a = polygon[i].point;
            const b = polygon[(i + 1) % polygon.length].point;
            area += a.x * b.y - b.x * a.y;
        }
        if (Math.abs(area) < 1e-5) {
            return [];
        }
        if (area < 0) {
            polygon.reverse();
        }

        const result: number[] = [];
        let remaining = polygon;
        let attempts = 0;
        while (remaining.length > 3 && attempts < points.length * points.length) {
            let clipped = false;
            for (let i = 0; i < remaining.length; i++) {
                const prev = remaining[(i + remaining.length - 1) % remaining.length];
                const curr = remaining[i];
                const next = remaining[(i + 1) % remaining.length];
                if (this.cross(prev.point, curr.point, next.point) <= 1e-5) {
                    continue;
                }
                if (remaining.some((candidate, candidateIndex) =>
                    candidateIndex !== i && candidateIndex !== (i + 1) % remaining.length &&
                    candidateIndex !== (i + remaining.length - 1) % remaining.length &&
                    this.isInsideTriangle(candidate.point, prev.point, curr.point, next.point))) {
                    continue;
                }

                result.push(prev.index, curr.index, next.index);
                remaining.splice(i, 1);
                clipped = true;
                break;
            }
            if (!clipped) {
                return [];
            }
            attempts++;
        }
        if (remaining.length === 3) {
            result.push(remaining[0].index, remaining[1].index, remaining[2].index);
        }
        return result;
    }

    private cross(a: Vec2, b: Vec2, c: Vec2): number {
        return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }

    private isInsideTriangle(point: Vec2, a: Vec2, b: Vec2, c: Vec2): boolean {
        const ab = this.cross(a, b, point);
        const bc = this.cross(b, c, point);
        const ca = this.cross(c, a, point);
        // Points on an ear edge do not block it. This is important for image outlines
        // where adjacent samples are frequently collinear.
        return ab > 1e-5 && bc > 1e-5 && ca > 1e-5;
    }

    private removeDegenerateVertices(polygon: { point: Vec2; index: number }[]): void {
        let changed = true;
        while (changed && polygon.length > 3) {
            changed = false;
            for (let i = 0; i < polygon.length; i++) {
                const prev = polygon[(i + polygon.length - 1) % polygon.length].point;
                const curr = polygon[i].point;
                const next = polygon[(i + 1) % polygon.length].point;
                const dx = curr.x - prev.x;
                const dy = curr.y - prev.y;
                const duplicate = dx * dx + dy * dy < 1e-10;
                if (duplicate || Math.abs(this.cross(prev, curr, next)) < 1e-7) {
                    polygon.splice(i, 1);
                    changed = true;
                    break;
                }
            }
        }
    }
}
