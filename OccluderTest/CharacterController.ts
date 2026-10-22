import { _decorator, Component, Node, tween, Vec3 } from 'cc';
const { ccclass, property } = _decorator;

@ccclass('CharacterController')
export class CharacterController extends Component {
    protected start(): void {
        this.node.eulerAngles = Vec3.ZERO.clone();
        const left = this.node.eulerAngles.clone();
        left.y += 30;
        const right = this.node.eulerAngles.clone();
        right.y -= 30;

        tween(this.node)
            .to(5, { eulerAngles: left }, { easing: 'sineInOut' })
            .to(5, { eulerAngles: right }, { easing: 'sineInOut' })
            .union()
            .repeatForever()
            .start();
    }
}

