import { Router, type IRouter } from "express";
import healthRouter from "./health";
import eventsRouter from "./events";
import submissionsRouter from "./submissions";
import storageRouter from "./storage";
import subscriptionsRouter from "./subscriptions";

const router: IRouter = Router();

router.use(healthRouter);
router.use(eventsRouter);
router.use(submissionsRouter);
router.use(storageRouter);
router.use(subscriptionsRouter);

export default router;
